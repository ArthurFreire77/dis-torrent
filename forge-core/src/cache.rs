//! Cache LRU em disco com limite de bytes configurável — para avatares,
//! thumbnails, emojis e spool de chunks de downloads (resume pós-queda).
//!
//! - Escrita atômica (tmp + rename): queda no meio não corrompe a entrada.
//! - "Acesso" atualiza o mtime do arquivo (LRU real por uso, não por idade).
//! - Prune por mtime quando o total passa do teto; nunca apaga o recém-escrito.
//! - Thread-safe (Mutex em torno do índice); operações são O(n log n) no prune
//!   e O(1) no get/put.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::{ForgeError, Result};

/// Spool de disco para chunks baixados. Precisa ser MAIOR que o maior arquivo
/// em andamento, senao o LRU come os proprios chunks que estao sendo baixados:
/// um arquivo de 300 MB com cap de 256 MB nunca completava.
const DEFAULT_CAP_BYTES: u64 = 4 * 1024 * 1024 * 1024; // 4 GB
/// 16 MB e' o piso: abaixo disso o cache sai do disco e o `cacheSetCap` do
/// painel (Configurações → Metrics) nunca consegue subir de volta.
const MIN_CAP_BYTES: u64 = 16 * 1024 * 1024; // 16 MB — abaixo disso nem cache

#[derive(Debug)]
struct Index {
    sizes: HashMap<String, u64>,
    total: u64,
}

pub struct DiskLru {
    dir: PathBuf,
    cap_bytes: Mutex<u64>,
    index: Mutex<Index>,
}

impl DiskLru {
    pub fn open(dir: PathBuf, cap_bytes: Option<u64>) -> Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let cache = Self {
            dir,
            cap_bytes: Mutex::new(cap_bytes.unwrap_or(DEFAULT_CAP_BYTES).max(MIN_CAP_BYTES)),
            index: Mutex::new(Index {
                sizes: HashMap::new(),
                total: 0,
            }),
        };
        cache.reindex()?;
        Ok(cache)
    }

    pub fn cap(&self) -> u64 {
        *self.cap_bytes.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set_cap(&self, cap_bytes: u64) -> Result<()> {
        let cap = cap_bytes.max(MIN_CAP_BYTES);
        *self.cap_bytes.lock().unwrap_or_else(|e| e.into_inner()) = cap;
        self.prune()?;
        Ok(())
    }

    pub fn total_bytes(&self) -> u64 {
        self.index.lock().unwrap_or_else(|e| e.into_inner()).total
    }

    pub fn entries(&self) -> usize {
        self.index
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sizes
            .len()
    }

    fn path_for(&self, key: &str) -> Result<PathBuf> {
        // chave sanitizada: blake3 do nome — evita path traversal via chave
        let h = hex::encode(&blake3::hash(key.as_bytes()).as_bytes()[..16]);
        Ok(self.dir.join(format!("{h}.bin")))
    }

    fn path_for_checked(&self, key: &str) -> Result<PathBuf> {
        let p = self.path_for(key)?;
        // defesa extra: o caminho resolvido nunca sai da raiz do cache
        if !p.starts_with(&self.dir) {
            return Err(ForgeError::Protocol("chave de cache inválida".into()));
        }
        Ok(p)
    }

    /// Reconstrói o índice a partir dos arquivos existentes (boot do app).
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
        self.prune()?;
        Ok(())
    }

    /// Grava (ou substitui) o valor e move para o "topo" do LRU.
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
        self.prune()?;
        Ok(())
    }

    /// Lê o valor e marca como usado (mtime = agora). None = ausente.
    pub fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let path = self.path_for_checked(key)?;
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
        // touch: LRU por USO, não por idade de criação
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

    /// Apaga tudo (modo pânico / reset).
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

    /// Remove entradas mais antigas até caber no teto. A entrada recém-escrita
    /// tem mtime AGORA, então nunca é a primeira a sair.
    fn prune(&self) -> Result<()> {
        let cap = self.cap();
        let mut idx = self.index.lock().unwrap_or_else(|e| e.into_inner());
        if idx.total <= cap {
            return Ok(());
        }
        // coleta (mtime, tamanho, nome) e ordena: mais velho primeiro
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
    fn lru_evicta_mais_antigo() {
        let dir = tempfile::tempdir().unwrap();
        // teto 16MB (piso do DiskLru) — usa blocos grandes para estourar
        let c = DiskLru::open(dir.path().to_path_buf(), Some(16 * 1024 * 1024)).unwrap();
        let block = vec![7u8; 6 * 1024 * 1024]; // 6MB
        c.put("a", &block).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(15));
        c.put("b", &block).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(15));
        // usa "a" — "b" vira o mais antigo
        assert!(c.get("a").unwrap().is_some());
        c.put("c", &block).unwrap(); // 18MB > 16MB → evicta o mais velho (b)
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
        // a chave é hashada — o arquivo fica DENTRO do dir
        let count = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(count, 1);
        assert_eq!(c.get("../../etc/passwd").unwrap().unwrap(), b"nope");
    }
}
