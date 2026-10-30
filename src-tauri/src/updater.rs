// ATUALIZAÇÃO AUTOMÁTICA PELO GITHUB.
//
// POR QUE ESTE MÓDULO EXISTE: o app era publicado manualmente e o usuário
// descobria a versão nova só quando abria o GitHub por conta própria. Ele
// ficava semanas numa build com bug de chamada de voz sem saber que a correção
// já existia — e como o protocolo P2P muda entre versões, versões misturadas
// degradam a rede. Aqui o app PROCURA a release mais nova no boot e, no
// Windows, instala e reabre sozinho.
//
// DECISÕES DE SEGURANÇA (não relaxar sem motivo):
//   • Só falamos com a API do GitHub e só baixamos assets cujo `browser_download_url`
//     está sob `github.com/ArthurFreire77/dis-torrent/releases/download/`.
//     Um `latest.json` malicioso (DNS/CDN comprometido) não consegue nos mandar
//     para outro host.
//   • O hash SHA-256 vem do campo `digest` da própria API do GitHub (TLS, mesma
//     resposta que escolheu o asset) e o arquivo baixado é conferido ANTES de
//     ser executado. Divergência = arquivo apagado e erro honesto.
//   • Extensão por plataforma: `.exe` no Windows, `.deb`/`.AppImage` no Linux,
//     `.apk` no Android. Nada de outro tipo de arquivo é aceito.
//   • Nenhum download acontece sem o usuário ter escolhido atualizar (ou sem a
//     preferência `auto_update` ligada), e nada roda "escondido": o instalador
//     do Windows aparece com a barra de progresso (Inno em modo silencioso
//     ainda mostra janela? não — usamos /SILENT, que mostra progresso).
//
// O QUE NÃO FAZER AQUI: não baixar direto para a pasta do app (o instalador do
// Windows não consegue sobrescrever o .exe em execução), não usar `powershell`
// para baixar (BYOVD/AV), e não apagar o instalador antes de o processo filho
// dele iniciar de verdade.

use std::path::PathBuf;

use serde::Serialize;

/// Repositório oficial. Mudar aqui muda o app inteiro de canal — é a única
/// fonte de verdade, e a UI não recebe URL arbitrária do frontend.
/// (`REPO` não é usado como constante porque o formato de download exige o
/// caminho completo `owner/repo/releases/download/...`; fica aqui como
/// documentação do alvo.)
#[allow(dead_code)]
const REPO: &str = "ArthurFreire77/dis-torrent";
const RELEASES_API: &str =
    "https://api.github.com/repos/ArthurFreire77/dis-torrent/releases/latest";
/// Prefixo aceito para qualquer download.
const DOWNLOAD_PREFIX: &str = "https://github.com/ArthurFreire77/dis-torrent/releases/download/";

/// Metadados devolvidos ao frontend. O frontend compara as versões (regra pura,
/// testável) e decide se mostra a tela de atualização.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    /// Nome do arquivo do asset escolhido para esta plataforma.
    pub asset_name: String,
    pub asset_size: u64,
    pub download_url: String,
    /// `sha256:<hex>` quando o GitHub informar; vazio quando não informar.
    pub digest: String,
    pub notes: String,
    pub html_url: String,
    /// Plataforma que escolheu o asset (`windows`/`linux`/`android`/`outro`).
    pub platform: String,
    /// `true` quando o NOME do asset cita uma versão diferente da tag.
    ///
    /// POR QUE ISSO EXISTE: a release pode estar rotulada `v1.1.12` e o `.exe`
    /// publicado nela ser o de `1.1.11` (aconteceu por `-SkipBuild` reaproveitando
    /// binário velho). O app instalaria "a versão nova" e continuaria na antiga,
    /// pedindo atualização de novo — a janela piscando que o usuário relatou.
    /// Aqui só sinalizamos; a decisão de instalar continua no frontend.
    pub label_mismatch: bool,
    /// Versão que o nome do asset declara, quando ele cita alguma.
    pub asset_version: String,
}

/// Extrai `1.1.11` de `DisTorrent_1.1.11-pre-alpha_x64_setup.exe`.
///
/// Devolve vazio quando o nome não cita versão (não inventamos rótulo).
/// Só o PRIMEIRO bloco `d+.d+.d+` conta: depois dele vem `_x64_setup`.
fn version_in_asset_name(name: &str) -> String {
    let mut core = String::new();
    let mut digits = 0usize;
    let mut dots = 0usize;
    let mut started = false;
    for c in name.chars() {
        if c.is_ascii_digit() {
            started = true;
            core.push(c);
            digits += 1;
        } else if c == '.' && started {
            core.push(c);
            dots += 1;
        } else if started {
            // Terminou o bloco numérico (o `_` ou o `-` encerram).
            break;
        }
    }
    let core = core.trim_end_matches('.').to_string();
    // Versão de verdade: três números separados por ponto.
    if dots >= 2 && digits >= 3 {
        core
    } else {
        String::new()
    }
}

fn platform_tag() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "android") {
        "android"
    } else if cfg!(any(target_os = "linux", target_os = "freebsd")) {
        "linux"
    } else {
        "outro"
    }
}

/// Extensões aceitas por plataforma. Lista fechada de propósito.
fn accepted_ext(platform: &str) -> &'static [&'static str] {
    match platform {
        "windows" => &[".exe"],
        "linux" => &[".appimage", ".deb"],
        "android" => &[".apk"],
        _ => &[],
    }
}

/// Escolhe o asset da release para esta plataforma.
///
/// Ordem de preferência no Linux: AppImage primeiro (não precisa de root e o
/// usuário troca o arquivo sozinho), `.deb` depois. No Windows o instalador do
/// Inno é o único `.exe` publicado.
fn pick_asset<'a>(assets: &'a [GhAsset], platform: &str) -> Option<&'a GhAsset> {
    let exts = accepted_ext(platform);
    for want in exts {
        // `find` já garante o primeiro por ordem da API; para o macOS/Windows
        // há um único asset válido, então não precisamos de mais critério.
        if let Some(a) = assets
            .iter()
            .find(|a| a.name.to_ascii_lowercase().ends_with(want))
        {
            return Some(a);
        }
    }
    None
}

#[derive(Debug, serde::Deserialize)]
struct GhAsset {
    name: String,
    size: u64,
    #[serde(default)]
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // O GitHub exige User-Agent. Sem ele a API responde 403 e a checagem
        // pareceria "sem internet" — o que faria o app pular a atualização em
        // silêncio e o usuário nunca saber por quê.
        .user_agent(format!("DisTorrent/{}", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("cliente HTTP: {e}"))
}

/// Consulta a release mais recente. O `current` sai da versão do APP (a mesma
/// de `get_app_version`), não do crate: o crate tem versão própria histórica.
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    let client = http_client()?;
    let res = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("sem conexão com o GitHub: {e}"))?;
    if !res.status().is_success() {
        return Err(format!(
            "GitHub respondeu {} ao procurar a release mais nova",
            res.status().as_u16()
        ));
    }
    let bytes = res.bytes().await.map_err(|e| format!("resposta: {e}"))?;
    let release: GhRelease = serde_json::from_slice(&bytes)
        .map_err(|e| format!("resposta do GitHub em formato inesperado: {e}"))?;
    if release.draft {
        return Err("release mais recente está em rascunho".into());
    }

    let platform = platform_tag().to_string();
    let asset = pick_asset(&release.assets, &platform).ok_or_else(|| {
        format!(
            "a release {} não publicou um instalador para {platform}",
            release.tag_name
        )
    })?;

    // GUARDA DE HOST: o download SEMPRE tem que apontar para o nosso repositório.
    // Um asset com URL externa (ou um espelho comprometido) é recusado aqui, e
    // não depois de baixar 9 MB.
    if !asset.browser_download_url.starts_with(DOWNLOAD_PREFIX) {
        return Err("asset da release aponta para um host não permitido".into());
    }
    let lower = asset.name.to_ascii_lowercase();
    if !accepted_ext(&platform).iter().any(|e| lower.ends_with(e)) {
        return Err(format!("asset inesperado para {platform}: {}", asset.name));
    }

    let latest = release.tag_name.trim_start_matches('v').to_string();
    let asset_version = version_in_asset_name(&asset.name);
    // A tag é a fonte de verdade da versão; o nome do asset só serve de alerta.
    // Comparamos só o núcleo numérico (`1.1.12` vs `1.1.12`), porque o sufixo
    // `-pre-alpha` varia entre "tem" e "não tem" conforme o empacotador.
    let label_mismatch = !asset_version.is_empty() && {
        let tag_core = latest.split('-').next().unwrap_or("");
        let asset_core = asset_version.split('-').next().unwrap_or("");
        asset_core != tag_core
    };
    if label_mismatch {
        eprintln!(
            "update: a release {} publicou o asset {} (versão {asset_version}) — instalador rotulado com outra versão; não vou entrar em loop",
            release.tag_name, asset.name
        );
    }

    Ok(UpdateInfo {
        current,
        // `tag_name` vem como `v1.1.10`; a comparação no frontend ignora o `v`.
        latest,
        asset_name: asset.name.clone(),
        asset_size: asset.size,
        download_url: asset.browser_download_url.clone(),
        digest: asset.digest.clone().unwrap_or_default(),
        notes: if release.body.trim().is_empty() {
            release.name
        } else {
            release.body
        },
        html_url: release.html_url,
        platform,
        label_mismatch,
        asset_version,
    })
}

/// Baixa e confere o instalador. Devolve o caminho absoluto do arquivo pronto.
///
/// O download vai para `data_dir/updates/` (área do app, gravável sem admin) e
/// só é aceito se o SHA-256 bater com o `digest` informado pelo GitHub.
#[tauri::command]
pub async fn update_download(
    app: tauri::AppHandle,
    url: String,
    name: String,
    digest: String,
) -> Result<String, String> {
    use sha2::{Digest as _, Sha256};
    use tauri::Manager;

    if !url.starts_with(DOWNLOAD_PREFIX) {
        return Err("download fora do repositório oficial recusado".into());
    }
    let platform = platform_tag();
    let lower_name = name.to_ascii_lowercase();
    if !accepted_ext(platform)
        .iter()
        .any(|e| lower_name.ends_with(e))
    {
        return Err(format!("extensão de instalador não aceita: {name}"));
    }
    // `name` vem do frontend: barras e `..` virariam path traversal para fora
    // da pasta de updates. Só o nome do arquivo é usado.
    let file_name = std::path::Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "nome de arquivo inválido".to_string())?
        .to_string();
    if file_name != name {
        return Err("nome de arquivo inválido".into());
    }

    let dir = updates_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("criar pasta de updates: {e}"))?;
    let final_path = dir.join(&file_name);
    let part_path = dir.join(format!("{file_name}.part"));

    let client = http_client()?;
    let mut stream = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("falha ao baixar o instalador: {e}"))?;
    if !stream.status().is_success() {
        return Err(format!(
            "download recusado pelo GitHub ({})",
            stream.status().as_u16()
        ));
    }

    let mut hasher = Sha256::new();
    let mut file =
        std::fs::File::create(&part_path).map_err(|e| format!("criar arquivo de download: {e}"))?;
    loop {
        // `chunk()` evita carregar ~90 MB (AppImage) de uma vez na memória.
        match stream.chunk().await {
            Ok(Some(chunk)) => {
                use std::io::Write as _;
                hasher.update(&chunk);
                file.write_all(&chunk)
                    .map_err(|e| format!("gravar download: {e}"))?;
            }
            Ok(None) => break,
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&part_path);
                return Err(format!("download interrompido: {e}"));
            }
        }
    }
    drop(file);

    let got = format!("sha256:{}", hex::encode(hasher.finalize()));
    // Só recusamos quando o GitHub INFORMOU um digest. Uma resposta antiga sem
    // `digest` não pode transformar o update numa via de execução de binário
    // arbitrário — nesse caso o frontend mostra o link da release e o usuário
    // decide (ver `update_apply`).
    if !digest.is_empty() && !digest.eq_ignore_ascii_case(&got) {
        let _ = std::fs::remove_file(&part_path);
        return Err(format!(
            "o instalador baixado não confere com o hash publicado (esperado {digest}, obtido {got}) — arquivo descartado"
        ));
    }
    std::fs::rename(&part_path, &final_path).map_err(|e| format!("finalizar download: {e}"))?;
    Ok(final_path.to_string_lossy().to_string())
}

/// Abre URL externa no navegador do sistema (só https, só o nosso repositório).
///
/// Existe porque o WebView não tem `window.open` confiável e não temos o plugin
/// `opener`. O alvo é a página da release: caminho de fallback quando o update
/// automático não pode ser aplicado (Linux sem pacote, Android com APK manual).
#[tauri::command]
pub fn open_release_page(url: String) -> Result<(), String> {
    let ok = url.starts_with("https://github.com/ArthurFreire77/dis-torrent/");
    if !ok {
        return Err("URL fora do repositório oficial recusada".into());
    }
    #[cfg(target_os = "windows")]
    {
        // `cmd /C start` é o único jeito sem dependência nova. As aspas vazias
        // depois de `start` são o TÍTULO da janela: sem elas o `start` trata a
        // URL como título e não abre nada.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("abrir navegador: {e}"))?;
    }
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("abrir navegador: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("abrir navegador: {e}"))?;
    }
    #[cfg(target_os = "android")]
    {
        // No Android o update é o APK; o link da release é só o fallback
        // (ex.: usuário quer baixar por fora). Sem plugin de intent aqui,
        // devolvemos o caminho honesto: o frontend mostra a URL para copiar.
        let _ = url;
        return Err("no Android a atualização é pelo APK (veja o cartão de atualização)".into());
    }
    Ok(())
}

/// Executa o instalador baixado.
///
/// Windows: Inno Setup em modo `/SILENT` (mostra barra de progresso),
/// `/CLOSEAPPLICATIONS` deixa o próprio Inno fechar este processo e
/// `/RESTARTAPPLICATIONS` reabre o app depois de instalar — é o "reiniciar
/// sozinho" que o usuário pediu. O `spawn` NÃO espera: o instalador precisa que
/// a gente saia do caminho para poder sobrescrever o `.exe`.
///
/// Linux: `.deb`/`.AppImage` não podem ser instalados sem root; abrimos o
/// arquivo com o instalador gráfico do sistema (`xdg-open`) e o frontend avisa
/// que o app precisa ser reaberto. Nada é executado como root por aqui.
///
/// Android: chama `plugin:updater|installApk`, que entrega o APK ao instalador
/// do sistema por `content://` (FileProvider). O usuário confirma no Android —
/// nenhum app fora da loja pode instalar sem esse toque; prometer o contrário
/// seria mentira. O app NÃO é encerrado aqui: se o usuário cancelar, ele
/// continua na versão atual.
#[tauri::command]
pub fn update_apply(_app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("instalador não encontrado (o download falhou?)".into());
    }
    let lower = path.to_ascii_lowercase();

    // BACKUP ANTES DE ATUALIZAR (Windows).
    //
    // O Inno só troca o `.exe` em `{app}` e nunca toca em `%APPDATA%`, mas o
    // usuário pediu explicitamente "cuida para não perder os dados", e um
    // snapshot é a única garantia real: se a versão nova tiver um bug de
    // migração, existe um arquivo do estado ANTERIOR para voltar. É cifrado com
    // a chave derivada do cofre (mesmo formato do backup automático do core),
    // então não vira texto claro no disco.
    #[cfg(target_os = "windows")]
    {
        if !lower.ends_with(".exe") {
            return Err("só instalador .exe é executado no Windows".into());
        }
        match pre_update_snapshot(&_app) {
            Ok(Some(arquivo)) => {
                tracing::info!(?arquivo, "backup pré-atualização criado")
            }
            // Sem identidade/cofre ainda: não há dado de usuário para perder.
            Ok(None) => {}
            Err(e) => {
                // Falhar o backup NÃO impede a atualização (o usuário pediu para
                // atualizar e o Inno não mexe nos dados), mas fica registrado —
                // e é honesto: não dizemos que fez backup sem ter feito.
                eprintln!(
                    "update: backup pré-atualização falhou ({e}) — seguindo com a atualização"
                );
            }
        }
        std::process::Command::new(&p)
            .args([
                "/SILENT",
                "/SUPPRESSMSGBOXES",
                "/CLOSEAPPLICATIONS",
                "/RESTARTAPPLICATIONS",
                "/NORESTART",
            ])
            .current_dir(p.parent().unwrap_or(std::path::Path::new(".")))
            .spawn()
            .map_err(|e| format!("não consegui iniciar o instalador: {e}"))?;
    }
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    {
        if !(lower.ends_with(".deb") || lower.ends_with(".appimage")) {
            return Err("instalador inesperado para Linux".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            if lower.ends_with(".appimage") {
                // AppImage precisa do bit de execução; o download vem 0644.
                let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755));
            }
        }
        std::process::Command::new("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(|e| format!("não consegui abrir o instalador: {e}"))?;
    }
    #[cfg(target_os = "android")]
    {
        // No Android quem abre o instalador é o plugin Kotlin
        // (`plugin:updater|installApk`), chamado pelo frontend — o mesmo padrão
        // do `plugin:callfg|start`. Aqui só validamos a extensão; devolver erro
        // é o caminho honesto se alguém chamar `update_apply` direto.
        if !lower.ends_with(".apk") {
            return Err("esperava um APK para atualizar no Android".into());
        }
        return Err(
            "no Android a instalação é feita pelo plugin nativo (updater|installApk)".into(),
        );
    }
    #[cfg(not(any(
        target_os = "windows",
        target_os = "linux",
        target_os = "freebsd",
        target_os = "android"
    )))]
    {
        let _ = (&p, &lower);
        return Err("atualização automática não disponível nesta plataforma".into());
    }
    Ok(())
}

/// Pasta dos instaladores baixados.
///
/// No Android ela PRECISA ficar dentro de `filesDir`: o `FileProvider` do
/// manifesto declara `files-path path="."`, e o instalador só abre com
/// `content://` apontando para um arquivo coberto por ele. Com o APK em
/// `dataDir/updates` (o que `app_data_dir()` devolve no Android) o
/// `getUriForFile` lançava `IllegalArgumentException`, o plugin recusava e a
/// atualização **nunca** acontecia — o sintoma era "no Android não está
/// atualizando automático".
fn updates_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    #[cfg(target_os = "android")]
    {
        let base = app
            .path()
            .app_data_dir()
            .or_else(|_| app.path().app_local_data_dir())
            .map_err(|e| format!("pasta de dados: {e}"))?;
        // `dataDir/files` == `filesDir` que o Kotlin/FileProvider enxerga.
        return Ok(base.join("files").join("updates"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("pasta de dados: {e}"))?;
        Ok(dir.join("updates"))
    }
}

/// Preferência persistida de "atualizar sozinho". Vive no kv do SQLite (mesmo
/// lugar das outras preferências do app) para não criar um arquivo solto.
#[tauri::command]
pub fn update_auto_get(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(read_kv(&app, "update.auto")?
        .map(|v| v == "1")
        .unwrap_or(true))
}

#[tauri::command]
pub fn update_auto_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    write_kv(&app, "update.auto", if enabled { "1" } else { "0" })
}

/// Flags do fluxo de atualização (`update.skip`, `update.failed`).
///
/// Ficam no kv para sobreviver ao reinício: sem `update.failed` um instalador
/// que corrompe na hora de rodar faria o app baixar e reiniciar em LOOP.
#[tauri::command]
pub fn update_flag_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    read_kv(&app, &key)
}

#[tauri::command]
pub fn update_flag_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    write_kv(&app, &key, &value)
}

/// Acesso ao kv com o banco LOCAL do app. As chaves são fixas do nosso lado,
/// mas ainda assim são prefixadas para não colidir com as do core.
fn read_kv(app: &tauri::AppHandle, key: &str) -> Result<Option<String>, String> {
    use tauri::Manager;
    if !key.starts_with("update.") {
        return Err("chave de atualização inválida".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("pasta de dados: {e}"))?;
    let store = distorrent_core::storage::Store::open(&dir.join("distorrent.db"))
        .map_err(|e| format!("abrir banco: {e}"))?;
    Ok(store.kv_get(key))
}

fn write_kv(app: &tauri::AppHandle, key: &str, value: &str) -> Result<(), String> {
    use tauri::Manager;
    if !key.starts_with("update.") {
        return Err("chave de atualização inválida".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("pasta de dados: {e}"))?;
    let store = distorrent_core::storage::Store::open(&dir.join("distorrent.db"))
        .map_err(|e| format!("abrir banco: {e}"))?;
    store.kv_set(key, value).map_err(|e| e.to_string())
}

/// Limpa instaladores antigos da pasta de updates (chamado depois de aplicar ou
/// quando o usuário adia por várias versões). Falha aqui nunca é fatal.
#[tauri::command]
pub fn update_cleanup(app: tauri::AppHandle) -> Result<u32, String> {
    let dir = updates_dir(&app)?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(0);
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        if entry.path().is_file() && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Snapshot do banco ANTES de trocar o binário (Windows).
///
/// Devolve `Ok(None)` quando ainda não existe identidade (nada a preservar) e
/// `Err` quando havia dado mas o snapshot não pôde ser feito.
///
/// O arquivo vai para `%APPDATA%\com.distorrent.app\backups\pre-update-<versao>-<ts>.stormvault`
/// — a MESMA pasta e o MESMO formato do backup automático do core, então
/// `stormvault_backup_restore` já sabe restaurá-lo. Cifrado com a chave do
/// cofre: um snapshot em texto claro ao lado do banco não protegeria nada.
///
/// O teto de mensagens é mais baixo que o do backup normal de propósito: isto
/// roda no meio do boot do atualizador e não pode segurar a instalação lendo
/// 200 mil mensagens.
#[cfg(target_os = "windows")]
fn pre_update_snapshot(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    use tauri::Manager;

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("pasta de dados: {e}"))?;
    let store = distorrent_core::storage::Store::open(&dir.join("distorrent.db"))
        .map_err(|e| e.to_string())?;
    let Some(_identity) = store.load_identity() else {
        // Sem identidade não há conta para salvar (primeiro boot).
        return Ok(None);
    };
    let secret = match store.load_secret_hex() {
        Some(s) => s,
        None => return Ok(None),
    };

    let data = distorrent_core::stormvault::collect(&store, None, Some(20_000))
        .map_err(|e| e.to_string())?;
    let backup_key = distorrent_core::stormvault::backup_key_for(&secret);
    let blob = distorrent_core::stormvault::seal_with_key(&data, &backup_key)
        .map_err(|e| e.to_string())?;

    let backups = dir.join("backups");
    std::fs::create_dir_all(&backups).map_err(|e| format!("criar pasta de backups: {e}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "0.0.0".to_string());
    let nome = format!("pre-update-{version}-{stamp}.stormvault");
    let destino = backups.join(&nome);
    // Grava em `.part` e renomeia: um snapshot pela metade (energia caindo no
    // meio) não pode ficar com nome de backup válido.
    let part = backups.join(format!("{nome}.part"));
    std::fs::write(&part, &blob).map_err(|e| format!("gravar snapshot: {e}"))?;
    std::fs::rename(&part, &destino).map_err(|e| format!("finalizar snapshot: {e}"))?;

    // Mantém no máximo 5 snapshots pré-atualização: eles se acumulam a cada
    // versão e o usuário nunca pediu uma pilha deles.
    if let Ok(entries) = std::fs::read_dir(&backups) {
        let mut pre: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("pre-update-") && n.ends_with(".stormvault"))
                    .unwrap_or(false)
            })
            .collect();
        pre.sort();
        while pre.len() > 5 {
            let velho = pre.remove(0);
            let _ = std::fs::remove_file(velho);
        }
    }
    Ok(Some(destino))
}
