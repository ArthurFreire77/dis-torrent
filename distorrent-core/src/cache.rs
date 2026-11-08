use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::{DistorrentError, Result};

const DEFAULT_CAP_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MIN_CAP_BYTES: u64 = 16 * 1024 * 1024;
/// Prévias baixadas ficam uma semana no disco; depois disso o chunk é lixo.
pub const DEFAULT_TTL_SECS: u64 = 7 * 24 * 60 * 60;

/// Teto do cache que cresce com o uso.
///
/// POR QUE cresce: começar com 256 MB fazia um único vídeo de 250 MB encher o
/// cache e expulsar todo o resto. O teto sobe conforme o histórico pede, mas
/// sempre com um limite — sem ele o cache viraria um segundo "Downloads".
pub const GROW_START_BYTES: u64 = 512 * 1024 * 1024;
pub const GROW_STEP_BYTES: u64 = 512 * 1024 * 1024;
pub const GROW_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Teto efetivo para o que já foi usado: o próximo degrau acima do maior
/// total já visto, limitado por `GROW_MAX_BYTES`. Determinístico pelo uso, sem
/// depender de relógio nem de configuração manual.
pub fn cap_para_uso(maior_uso: u64) -> u64 {
    if maior_uso <= GROW_START_BYTES {
        return GROW_START_BYTES;
    }
    let passos = maior_uso.div_ceil(GROW_STEP_BYTES);
    (passos * GROW_STEP_BYTES).min(GROW_MAX_BYTES)
}

/// Cresce só quando `behaviour` é automático. Teto fixo (teste ou escolha do
/// usuário) NÃO cresce — senão a poda deixa de ser previsível.
fn deve_crescer(autogrow: bool) -> bool {
    autogrow
}

#[derive(Debug)]
struct Index {
    sizes: HashMap<String, u64>,
    total: u64,
}

pub struct DiskLru {
    dir: PathBuf,
    cap_bytes: Mutex<u64>,
    ttl_secs: Mutex<u64>,
    high_water: Mutex<u64>,
    /// `true` quando o teto acompanha o uso; `false` quando foi fixado.
    autogrow: std::sync::atomic::AtomicBool,
    index: Mutex<Index>,
}

impl DiskLru {
    pub fn open(dir: PathBuf, cap_bytes: Option<u64>) -> Result<Self> {
        Self::open_with_ttl(dir, cap_bytes, DEFAULT_TTL_SECS)
    }

    pub fn open_with_ttl(dir: PathBuf, cap_bytes: Option<u64>, ttl_secs: u64) -> Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let cache = Self {
            dir,
            cap_bytes: Mutex::new(cap_bytes.unwrap_or(DEFAULT_CAP_BYTES).max(MIN_CAP_BYTES)),
            ttl_secs: Mutex::new(ttl_secs.max(60)),
            high_water: Mutex::new(0),
            autogrow: std::sync::atomic::AtomicBool::new(false),
            index: Mutex::new(Index {
                sizes: HashMap::new(),
                total: 0,
            }),
        };
        cache.reindex()?;
        Ok(cache)
    }

    /// Cache de prévias do app: começa em `GROW_START_BYTES` e sobe conforme o
    /// uso, sempre limitado por `GROW_MAX_BYTES`. É o modo que o usuário pediu
    /// ("aumenta gradualmente conforme o uso").
    pub fn open_growing(dir: PathBuf, ttl_secs: u64) -> Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let cache = Self {
            dir,
            cap_bytes: Mutex::new(GROW_START_BYTES),
            ttl_secs: Mutex::new(ttl_secs.max(60)),
            high_water: Mutex::new(0),
            autogrow: std::sync::atomic::AtomicBool::new(true),
            index: Mutex::new(Index {
                sizes: HashMap::new(),
                total: 0,
            }),
        };
        cache.reindex()?;
        Ok(cache)
    }

    pub fn ttl_secs(&self) -> u64 {
        *self.ttl_secs.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_ttl(&self, ttl_secs: u64) -> Result<()> {
        *self.ttl_secs.lock().unwrap_or_else(|e| e.into_inner()) = ttl_secs.max(60);
        self.prune()?;
        Ok(())
    }

    pub fn cap(&self) -> u64 {
        *self.cap_bytes.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn total_bytes(&self) -> u64 {
        self.index.lock().unwrap_or_else(|e| e.into_inner()).total
    }

    /// Maior total já ocupado desde o último boot: é o que faz o teto crescer
    /// para o próximo degrau sem apagar o que o usuário acabou de baixar.
    pub fn high_water(&self) -> u64 {
        self.high_water
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .to_owned()
    }

    /// Sobe o teto para o próximo degrau se o uso chegou perto do atual.
    fn grow_if_needed(&self) {
        if !deve_crescer(self.autogrow.load(std::sync::atomic::Ordering::Relaxed)) {
            return;
        }
        let total = self.total_bytes();
        {
            let mut hw = self.high_water.lock().unwrap_or_else(|e| e.into_inner());
            if total > *hw {
                *hw = total;
            }
        }
        let novo = cap_para_uso(total);
        let mut cap = self.cap_bytes.lock().unwrap_or_else(|e| e.into_inner());
        if novo > *cap {
            *cap = novo;
        }
    }

    /// Fixa o teto (escolha explícita). Desliga o crescimento automático.
    pub fn set_cap(&self, cap_bytes: u64) -> Result<()> {
        let cap = cap_bytes.max(MIN_CAP_BYTES);
        self.autogrow
            .store(false, std::sync::atomic::Ordering::Relaxed);
        *self.cap_bytes.lock().unwrap_or_else(|e| e.into_inner()) = cap;
        self.prune()?;
        Ok(())
    }

    pub fn entries(&self) -> usize {
        self.index
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sizes
            .len()
    }

    fn path_for(&self, key: &str) -> Result<PathBuf> {
        let h = hex::encode(&blake3::hash(key.as_bytes()).as_bytes()[..16]);
        Ok(self.dir.join(format!("{h}.bin")))
    }

    fn path_for_checked(&self, key: &str) -> Result<PathBuf> {
        let p = self.path_for(key)?;
        if !p.starts_with(&self.dir) {
            return Err(DistorrentError::Protocol("chave de cache inválida".into()));
        }
        Ok(p)
    }

    fn reindex(&self) -> Result<()> {
        let mut sizes = HashMap::new();
        let mut total = 0u64;
        if let Ok(rd) = std::fs::read_dir(&self.dir) {
            for entry in rd.flatten() {
                let Ok(md) = entry.metadata() else { continue };
                if !md.is_file() {
                    continue;
                }
                total += md.len();
                sizes.insert(entry.file_name().to_string_lossy().to_string(), md.len());
            }
        }
        *self.index.lock().unwrap_or_else(|e| e.into_inner()) = Index { sizes, total };
        // No boot o teto sobe para caber o que já está em disco: senão a
        // primeira poda apagaria mídia que o usuário ainda quer ver.
        self.grow_if_needed();
        self.prune()?;
        Ok(())
    }

    pub fn put(&self, key: &str, bytes: &[u8]) -> Result<()> {
        let path = self.path_for_checked(key)?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &path)?;
        let mut idx = self.index.lock().unwrap_or_else(|e| e.into_inner());
        let prev = idx
            .sizes
            .get(&path.file_name().unwrap().to_string_lossy().to_string())
            .copied()
            .unwrap_or(0);
        idx.sizes.insert(
            path.file_name().unwrap().to_string_lossy().to_string(),
            bytes.len() as u64,
        );
        idx.total = idx.total.saturating_sub(prev) + bytes.len() as u64;
        drop(idx);
        // Antes de podar: se o uso cresceu, sobe o teto. Podar primeiro
        // expulsaria a mídia antiga justamente quando há espaço para crescer.
        self.grow_if_needed();
        self.prune()?;
        Ok(())
    }

    pub fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let path = self.path_for_checked(key)?;
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
        let now = filetime::FileTime::now();
        let _ = filetime::set_file_times(&path, now, now);
        Ok(Some(bytes))
    }

    pub fn delete(&self, key: &str) -> Result<()> {
        let path = self.path_for_checked(key)?;
        let mut idx = self.index.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(md) = std::fs::metadata(&path) {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if idx.sizes.remove(&name).is_some() {
                idx.total = idx.total.saturating_sub(md.len());
            }
        }
        drop(idx);
        let _ = std::fs::remove_file(&path);
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        if let Ok(rd) = std::fs::read_dir(&self.dir) {
            for entry in rd.flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        *self.index.lock().unwrap_or_else(|e| e.into_inner()) = Index {
            sizes: HashMap::new(),
            total: 0,
        };
        Ok(())
    }

    fn prune(&self) -> Result<()> {
        let cap = self.cap();
        let ttl = std::time::Duration::from_secs(self.ttl_secs());
        let agora = std::time::SystemTime::now();
        let mut idx = self.index.lock().unwrap_or_else(|e| e.into_inner());
        let mut infos: Vec<(std::time::SystemTime, u64, String)> =
            Vec::with_capacity(idx.sizes.len());
        for name in idx.sizes.keys() {
            let p = self.dir.join(name);
            let Ok(md) = std::fs::metadata(&p) else {
                continue;
            };
            let mtime = md.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            infos.push((mtime, md.len(), name.clone()));
        }
        // TTL primeiro: a prévia vence mesmo com espaço sobrando no cache.
        let mut expirados: Vec<(std::time::SystemTime, u64, String)> = Vec::new();
        infos.retain(|(mtime, size, name)| {
            let venceu = agora
                .duration_since(*mtime)
                .map(|d| d > ttl)
                .unwrap_or(false);
            if venceu {
                expirados.push((*mtime, *size, name.clone()));
            }
            !venceu
        });
        for (_, size, name) in expirados {
            let _ = std::fs::remove_file(self.dir.join(&name));
            if idx.sizes.remove(&name).is_some() {
                idx.total = idx.total.saturating_sub(size);
            }
        }
        if idx.total <= cap {
            return Ok(());
        }
        infos.sort();
        for (_, size, name) in infos {
            if idx.total <= cap {
                break;
            }
            let _ = std::fs::remove_file(self.dir.join(&name));
            if idx.sizes.remove(&name).is_some() {
                idx.total = idx.total.saturating_sub(size);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(i: usize) -> String {
        format!("chave-{i}")
    }

    #[test]
    fn put_get_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let c = DiskLru::open(dir.path().to_path_buf(), Some(16 * 1024 * 1024)).unwrap();
        c.put(&key(1), b"valor-um").unwrap();
        assert_eq!(c.get(&key(1)).unwrap().unwrap(), b"valor-um");
        assert_eq!(c.total_bytes(), 8);
        assert_eq!(c.entries(), 1);
    }

    #[test]
    fn get_inexistente_none() {
        let dir = tempfile::tempdir().unwrap();
        let c = DiskLru::open(dir.path().to_path_buf(), None).unwrap();
        assert!(c.get("nao-existe").unwrap().is_none());
    }

    #[test]
    fn teto_cresce_com_o_uso_e_respeita_o_maximo() {
        // 512 MB de início; sobe de 512 em 512 até 8 GB.
        assert_eq!(cap_para_uso(0), GROW_START_BYTES);
        assert_eq!(cap_para_uso(100 * 1024 * 1024), GROW_START_BYTES);
        assert_eq!(cap_para_uso(GROW_START_BYTES), GROW_START_BYTES);
        assert_eq!(
            cap_para_uso(GROW_START_BYTES + 1),
            GROW_START_BYTES + GROW_STEP_BYTES
        );
        assert_eq!(cap_para_uso(3 * 1024 * 1024 * 1024), 3 * 1024 * 1024 * 1024);
        assert_eq!(cap_para_uso(7 * 1024 * 1024 * 1024), 7 * 1024 * 1024 * 1024);
        assert_eq!(
            cap_para_uso(100 * 1024 * 1024 * 1024),
            GROW_MAX_BYTES,
            "nunca passa do teto"
        );
    }

    #[test]
    fn put_acima_do_teto_inicial_sobe_o_teto_em_vez_de_expulsar() {
        let dir = tempfile::tempdir().unwrap();
        // Modo crescente (é o do app): começa em 512 MB e sobe com o uso.
        let c = DiskLru::open_growing(dir.path().to_path_buf(), DEFAULT_TTL_SECS).unwrap();
        assert_eq!(c.cap(), GROW_START_BYTES);
        // Enche até passar do teto inicial: o teto sobe e nada é expulso.
        let passo = 64 * 1024 * 1024;
        for i in 0..10 {
            c.put(&format!("k{i}"), &vec![1u8; passo]).unwrap();
        }
        assert!(c.cap() > GROW_START_BYTES, "teto cresceu com o uso");
        assert!(
            c.get("k0").unwrap().is_some(),
            "nada foi expulso ao crescer"
        );
        assert_eq!(c.entries(), 10);
        assert!(c.high_water() >= 10 * passo as u64);
    }

    #[test]
    fn teto_fixo_nao_cresce() {
        // `set_cap` é escolha explícita: o teto fica onde o usuário mandou.
        let dir = tempfile::tempdir().unwrap();
        let c = DiskLru::open(dir.path().to_path_buf(), Some(16 * 1024 * 1024)).unwrap();
        c.set_cap(16 * 1024 * 1024).unwrap();
        for i in 0..6 {
            c.put(&format!("k{i}"), &vec![1u8; 6 * 1024 * 1024])
                .unwrap();
        }
        assert_eq!(c.cap(), 16 * 1024 * 1024, "teto fixo não pode crescer");
        assert!(c.total_bytes() <= c.cap());
    }

    #[test]
    fn ttl_continua_expirando_mesmo_com_teto_maior() {
        let dir = tempfile::tempdir().unwrap();
        let c =
            DiskLru::open_with_ttl(dir.path().to_path_buf(), Some(64 * 1024 * 1024), 60).unwrap();
        c.put("velho", b"dados").unwrap();
        // Envelhece o mtime além do TTL.
        let p = {
            let mut it = std::fs::read_dir(dir.path()).unwrap();
            it.next().unwrap().unwrap().path()
        };
        let antigo = filetime::FileTime::from_unix_time(1_600_000_000, 0);
        filetime::set_file_times(&p, antigo, antigo).unwrap();
        c.put("novo", b"x").unwrap();
        assert!(
            c.get("velho").unwrap().is_none(),
            "TTL manda mais que o teto"
        );
        assert!(c.get("novo").unwrap().is_some());
    }

    #[test]
    fn lru_evicta_mais_antigo() {
        let dir = tempfile::tempdir().unwrap();
        let c = DiskLru::open(dir.path().to_path_buf(), Some(16 * 1024 * 1024)).unwrap();
        let block = vec![7u8; 6 * 1024 * 1024];
        c.put("a", &block).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(15));
        c.put("b", &block).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(15));
        assert!(c.get("a").unwrap().is_some());
        c.put("c", &block).unwrap();
        assert!(c.get("a").unwrap().is_some(), "a foi usado, deve ficar");
        assert!(c.get("c").unwrap().is_some(), "c acabou de entrar");
        assert!(c.get("b").unwrap().is_none(), "b é o LRU, deve sair");
        assert!(c.total_bytes() <= c.cap());
    }

    #[test]
    fn delete_e_clear() {
        let dir = tempfile::tempdir().unwrap();
        let c = DiskLru::open(dir.path().to_path_buf(), None).unwrap();
        c.put("x", b"1").unwrap();
        c.put("y", b"22").unwrap();
        c.delete("x").unwrap();
        assert!(c.get("x").unwrap().is_none());
        assert!(c.get("y").unwrap().is_some());
        c.clear().unwrap();
        assert_eq!(c.entries(), 0);
        assert_eq!(c.total_bytes(), 0);
    }

    #[test]
    fn reindex_no_boot_conta_arquivos_existentes() {
        let dir = tempfile::tempdir().unwrap();
        let c = DiskLru::open(dir.path().to_path_buf(), None).unwrap();
        c.put("k", b"12345").unwrap();
        drop(c);
        let c2 = DiskLru::open(dir.path().to_path_buf(), None).unwrap();
        assert_eq!(c2.total_bytes(), 5);
        assert_eq!(c2.get("k").unwrap().unwrap(), b"12345");
    }

    #[test]
    fn chave_maliciosa_nao_escapa_do_dir() {
        let dir = tempfile::tempdir().unwrap();
        let c = DiskLru::open(dir.path().to_path_buf(), None).unwrap();
        c.put("../../etc/passwd", b"nope").unwrap();
        let count = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(count, 1);
        assert_eq!(c.get("../../etc/passwd").unwrap().unwrap(), b"nope");
    }
}
