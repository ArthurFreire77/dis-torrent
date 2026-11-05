use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameKind {
    User,
    Server,
    Channel,
}

impl NameKind {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "user" => Some(Self::User),
            "server" => Some(Self::Server),
            "channel" => Some(Self::Channel),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct NamePolicy {
    pub min_len: usize,
    pub max_len: usize,
    pub extra_banned: Vec<String>,
}

impl NamePolicy {
    pub fn for_kind(kind: NameKind) -> Self {
        match kind {
            NameKind::User => Self {
                min_len: 2,
                max_len: 32,
                extra_banned: vec![],
            },
            NameKind::Server => Self {
                min_len: 3,
                max_len: 64,
                extra_banned: vec![],
            },
            NameKind::Channel => Self {
                min_len: 2,
                max_len: 40,
                extra_banned: vec![],
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameCheck {
    pub ok: bool,
    pub normalized: String,
    pub errors: Vec<String>,
    pub suggestions: Vec<String>,
}

pub fn base_blocklist() -> Vec<&'static str> {
    vec![
        "porra",
        "caralho",
        "merda",
        "puta",
        "puto",
        "viado",
        "bicha",
        "corno",
        "fdp",
        "filhodaputa",
        "otario",
        "otário",
        "idiota",
        "imbecil",
        "retardado",
        "nazista",
        "hitler",
        "cuzao",
        "cuzão",
        "buceta",
        "xota",
        "siririca",
        "fuck",
        "shit",
        "bitch",
        "whore",
        "slut",
        "nigger",
        "nigga",
        "faggot",
        "retard",
        "kike",
        "tranny",
        "pedo",
        "rapist",
        "free-nitro",
        "steam-gift",
        "airdrop-claim",
    ]
}

pub fn reserved_titles() -> Vec<&'static str> {
    vec![
        "admin",
        "administrador",
        "moderador",
        "moderator",
        "mod",
        "storm oficial",
        "stormoficial",
        "storm team",
        "suporte",
        "support",
        "dono",
        "owner",
        "sistema",
        "system",
        "bot oficial",
    ]
}

pub fn sanitize_text(input: &str, max_chars: usize) -> String {
    let nfc: String = input.nfc().collect();
    let mut out = String::with_capacity(nfc.len().min(max_chars));
    for c in nfc.chars() {
        if c.is_control() && c != '\n' && c != '\t' {
            continue;
        }
        if matches!(c, '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}'
            | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{00AD}')
        {
            continue;
        }
        if out.chars().count() >= max_chars {
            break;
        }
        out.push(c);
    }
    let mut collapsed = String::with_capacity(out.len());
    let mut spaces = 0usize;
    let mut newlines = 0usize;
    for c in out.chars() {
        if c == '\n' {
            newlines += 1;
            spaces = 0;
            if newlines <= 2 {
                collapsed.push(c);
            }
        } else if c.is_whitespace() {
            spaces += 1;
            newlines = 0;
            if spaces <= 1 {
                collapsed.push(' ');
            }
        } else {
            spaces = 0;
            newlines = 0;
            collapsed.push(c);
        }
    }
    collapsed.trim().to_string()
}

// Seção 1: escape_html
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            '`' => out.push_str("&#x60;"),
            _ => out.push(c),
        }
    }
    out
}

pub fn skeleton(name: &str) -> String {
    let nfc: String = name.nfc().collect::<String>().to_lowercase();
    let mut out = String::with_capacity(nfc.len());
    for c in nfc.chars() {
        let mapped: &str = match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' | 'а' => "a",
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'е' => "e",
            'ì' | 'í' | 'î' | 'ï' | 'і' => "i",
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'о' => "o",
            'ù' | 'ú' | 'û' | 'ü' => "u",
            'ç' | 'ć' | 'č' | 'с' => "c",
            'ñ' | 'ń' => "n",
            'ý' | 'ÿ' => "y",
            'ß' => "ss",
            'æ' => "ae",
            'œ' => "oe",
            'þ' => "th",
            'ð' => "d",
            'ł' => "l",
            'ś' | 'š' | 'ş' => "s",
            'ź' | 'ż' | 'ž' => "z",
            '0' | 'ο' => "o",
            '1' | '!' | '|' | 'l' => "i",
            '3' => "e",
            '4' | '@' => "a",
            '5' => "s",
            '7' => "t",
            '8' => "b",
            '9' => "g",
            '$' => "s",
            '€' => "e",
            '£' => "l",
            'ρ' => "p",
            'κ' => "k",
            'η' => "n",
            'м' => "m",
            'т' => "t",
            'х' => "x",
            'ѕ' => "s",
            c if c.is_whitespace() || c == '_' || c == '-' || c == '.' => "",
            c if c.is_alphanumeric() => {
                out.push(c);
                continue;
            }
            _ => "",
        };
        out.push_str(mapped);
    }
    out
}

fn contains_blocked(skeletonized: &str, banned: &[String]) -> Option<String> {
    for w in banned {
        let w = w.trim().to_lowercase();
        if w.is_empty() {
            continue;
        }
        if skeletonized.contains(&skeleton(&w)) {
            return Some(w);
        }
    }
    None
}

fn has_dangerous_chars(s: &str) -> Vec<char> {
    let mut bad = vec![];
    for c in s.chars() {
        if matches!(c, '<' | '>' | '"' | '\'' | '\\' | '`')
            || c.is_control()
            || matches!(c, '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}'
                | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{00AD}')
        {
            if !bad.contains(&c) {
                bad.push(c);
            }
        }
    }
    bad
}

pub fn validate_name(
    kind: NameKind,
    raw: &str,
    existing: &[String],
    policy: &NamePolicy,
) -> NameCheck {
    let mut errors: Vec<String> = vec![];
    let nfc: String = raw.nfc().collect();
    let collapsed = nfc.split_whitespace().collect::<Vec<_>>().join(" ");
    let normalized = collapsed.trim().to_string();
    let len = normalized.chars().count();

    if normalized.is_empty() {
        errors.push("nome vazio".into());
    }
    if len < policy.min_len {
        errors.push(format!(
            "muito curto (mínimo {} caracteres)",
            policy.min_len
        ));
    }
    if len > policy.max_len {
        errors.push(format!(
            "muito longo (máximo {} caracteres)",
            policy.max_len
        ));
    }
    let bad = has_dangerous_chars(raw);
    if !bad.is_empty() {
        errors.push("contém caracteres proibidos (< > \" ' \\ `, controles ou invisíveis)".into());
    }
    let allowed = |c: char| c.is_alphanumeric() || matches!(c, ' ' | '_' | '-' | '.');
    if !normalized.chars().all(allowed) {
        errors.push("use apenas letras, números, espaço, _ - .".into());
    }
    if matches!(kind, NameKind::Channel) && normalized.chars().any(|c| c.is_uppercase() || c == ' ')
    {
        errors.push("canal: use minúsculas e hífen (ex.: avisos-gerais)".into());
    }

    let skel = skeleton(&normalized);
    let mut banned: Vec<String> = base_blocklist()
        .into_iter()
        .map(|s| s.to_string())
        .collect();
    banned.extend(policy.extra_banned.iter().cloned());
    if let Some(w) = contains_blocked(&skel, &banned) {
        errors.push(format!("contém termo bloqueado: {w}"));
    }
    let titles: Vec<String> = reserved_titles()
        .into_iter()
        .map(|s| s.to_string())
        .collect();
    if contains_blocked(&skel, &titles).is_some() {
        errors.push("nome imita cargo oficial (admin/moderador/storm)".into());
    }

    let existing_skel: Vec<String> = existing.iter().map(|e| skeleton(e)).collect();
    if existing_skel.iter().any(|e| e == &skel) {
        errors.push("nome já existe neste escopo".into());
    }
    if existing_skel.iter().any(|e| levenshtein1(&skel, e))
        && !existing_skel.iter().any(|e| e == &skel)
    {
        errors.push("muito parecido com um nome existente (anti-spoof)".into());
    }

    // Seção 2: ok
    let ok = errors.is_empty();
    let suggestions = if ok {
        vec![]
    } else {
        suggest_variants(&normalized, existing)
    };
    NameCheck {
        ok,
        normalized,
        errors,
        suggestions,
    }
}

fn levenshtein1(a: &str, b: &str) -> bool {
    if a == b {
        return false;
    }
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let (mut i, mut j, mut edits) = (0usize, 0usize, 0u32);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            i += 1;
            j += 1;
        } else {
            edits += 1;
            if edits > 1 {
                return false;
            }
            if a.len() == b.len() {
                i += 1;
                j += 1;
            } else if a.len() > b.len() {
                i += 1;
            } else {
                j += 1;
            }
        }
    }
    edits + (a.len() - i + b.len() - j) as u32 == 1
}

pub fn suggest_variants(base: &str, existing: &[String]) -> Vec<String> {
    let clean: String = skeleton(base)
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect();
    let clean = if clean.is_empty() {
        "user".to_string()
    } else {
        clean.chars().take(20).collect()
    };
    let taken: Vec<String> = existing.iter().map(|e| skeleton(e)).collect();
    let mut out = vec![];
    for cand in [
        format!("{clean}_01"),
        format!("{clean}_2025"),
        format!("{clean}_x"),
    ] {
        if !taken.iter().any(|t| t == &skeleton(&cand)) {
            out.push(cand);
        }
        if out.len() == 3 {
            break;
        }
    }
    let mut n = 2u32;
    while out.len() < 3 && n < 100 {
        let cand = format!("{clean}_{n:02}");
        if !taken.iter().any(|t| t == &skeleton(&cand)) {
            out.push(cand);
        }
        n += 1;
    }
    out
}

pub fn random_name() -> String {
    const ADJ: &[&str] = &[
        "veloz", "bravo", "lunar", "solar", "feroz", "calmo", "vivo", "norte",
    ];
    const NOUN: &[&str] = &[
        "lobo", "falcão", "rio", "monte", "farol", "vento", "cacto", "atlas",
    ];
    let mut b = [0u8; 2];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
    let a = ADJ[b[0] as usize % ADJ.len()];
    let n = NOUN[b[1] as usize % NOUN.len()];
    let num = 10 + (b[0] as u16 + b[1] as u16 * 7) % 89;
    format!("{a}_{n}_{num}")
}

pub fn safety_number(fp_a: &str, pub_a: &str, fp_b: &str, pub_b: &str) -> String {
    let (x, y) = if fp_a <= fp_b {
        ((fp_a, pub_a), (fp_b, pub_b))
    } else {
        ((fp_b, pub_b), (fp_a, pub_a))
    };
    let mut h = blake3::Hasher::new();
    h.update(b"storm/safety-number/v1|");
    h.update(x.0.as_bytes());
    h.update(b"|");
    h.update(x.1.as_bytes());
    h.update(b"|");
    h.update(y.0.as_bytes());
    h.update(b"|");
    h.update(y.1.as_bytes());
    let digest = h.finalize();
    let bytes = digest.as_bytes();
    let mut groups = vec![];
    for i in 0..8 {
        let v = u32::from_be_bytes([
            bytes[i * 4],
            bytes[i * 4 + 1],
            bytes[i * 4 + 2],
            bytes[i * 4 + 3],
        ]) % 100_000;
        groups.push(format!("{v:05}"));
    }
    groups.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nfc_unifica_homoglifo() {
        let a = validate_name(
            NameKind::User,
            "café",
            &[],
            &NamePolicy::for_kind(NameKind::User),
        );
        let b = validate_name(
            NameKind::User,
            "cafe\u{301}",
            &[],
            &NamePolicy::for_kind(NameKind::User),
        );
        assert!(a.ok && b.ok);
        assert_eq!(a.normalized, b.normalized);
    }

    #[test]
    fn zero_width_e_bidi_bloqueados() {
        let p = NamePolicy::for_kind(NameKind::User);
        assert!(!validate_name(NameKind::User, "ad\u{200B}min", &[], &p).ok);
        assert!(!validate_name(NameKind::User, "user\u{202E}test", &[], &p).ok);
    }

    #[test]
    fn injecao_html_bloqueada() {
        let p = NamePolicy::for_kind(NameKind::User);
        let r = validate_name(NameKind::User, "<script>alert(1)</script>", &[], &p);
        assert!(!r.ok);
        assert_eq!(escape_html("<a>"), "&lt;a&gt;");
    }

    // Seção 3: test
    #[test]
    fn blocklist_e_cargos() {
        let p = NamePolicy::for_kind(NameKind::User);
        assert!(!validate_name(NameKind::User, "Admin Supremo", &[], &p).ok);
        assert!(!validate_name(NameKind::User, "storm oficial", &[], &p).ok);
        assert!(!validate_name(NameKind::User, "caralho99", &[], &p).ok);
        assert!(!validate_name(NameKind::User, "4dm1n", &[], &p).ok);
    }

    #[test]
    fn spoof_homoglifo_cirilico() {
        let p = NamePolicy::for_kind(NameKind::User);
        let r = validate_name(NameKind::User, "аdmin", &[], &p);
        assert!(!r.ok);
        let r2 = validate_name(NameKind::User, "marcos", &["marco".to_string()], &p);
        assert!(!r2.ok);
        assert!(r2.errors.iter().any(|e| e.contains("parecido")));
    }

    #[test]
    fn unicidade_e_sugestoes() {
        let p = NamePolicy::for_kind(NameKind::User);
        let r = validate_name(NameKind::User, "ana", &["ana".to_string()], &p);
        assert!(!r.ok);
        assert!(!r.suggestions.is_empty());
        assert!(r.suggestions[0].starts_with("ana"));
    }

    #[test]
    fn canal_minusculas() {
        let p = NamePolicy::for_kind(NameKind::Channel);
        assert!(!validate_name(NameKind::Channel, "Avisos Gerais", &[], &p).ok);
        assert!(validate_name(NameKind::Channel, "avisos-gerais", &[], &p).ok);
    }

    #[test]
    fn safety_number_simetrico() {
        let ab = safety_number("aaa", "pubA", "bbb", "pubB");
        let ba = safety_number("bbb", "pubB", "aaa", "pubA");
        assert_eq!(ab, ba);
        assert_eq!(ab.split(' ').count(), 8);
    }

    #[test]
    fn sanitize_remove_fantasmas_e_limita() {
        let s = sanitize_text("oi\u{200B}<b>teste</b>\u{202E}xxx", 100);
        assert!(!s.contains('\u{200B}'));
        assert!(!s.contains('\u{202E}'));
        let big = "a".repeat(500);
        assert!(sanitize_text(&big, 10).chars().count() <= 10);
    }
}
