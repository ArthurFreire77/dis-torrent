use crate::{DistorrentError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SniffedMime {
    Jpeg,
    Png,
    Gif,
    Webp,
    Mp4,
    Webm,
    Ogg,
    Pdf,
    Zip,
    WindowsExecutable,
    ElfExecutable,
    Script,
    JavaArchive,
    Unknown,
}

impl SniffedMime {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Mp4 => "video/mp4",
            Self::Webm => "video/webm",
            Self::Ogg => "audio/ogg",
            Self::Pdf => "application/pdf",
            Self::Zip => "application/zip",
            Self::WindowsExecutable => "application/x-msdownload",
            Self::ElfExecutable => "application/x-executable",
            Self::Script => "text/x-script",
            Self::JavaArchive => "application/java-archive",
            Self::Unknown => "application/octet-stream",
        }
    }

    pub fn is_executable(self) -> bool {
        matches!(
            self,
            Self::WindowsExecutable | Self::ElfExecutable | Self::Script | Self::JavaArchive
        )
    }
}

pub fn sniff_mime(bytes: &[u8]) -> SniffedMime {
    if bytes.len() < 4 {
        return SniffedMime::Unknown;
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return SniffedMime::Jpeg;
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return SniffedMime::Png;
    }
    if bytes.starts_with(b"GIF8") {
        return SniffedMime::Gif;
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return SniffedMime::Webp;
    }
    if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return SniffedMime::Webm;
    }
    if bytes.starts_with(b"OggS") {
        return SniffedMime::Ogg;
    }
    if bytes.starts_with(b"%PDF") {
        return SniffedMime::Pdf;
    }
    if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") {
        return SniffedMime::Zip;
    }
    if bytes.starts_with(&[0x4D, 0x5A]) {
        return SniffedMime::WindowsExecutable;
    }
    if bytes.starts_with(&[0x7F, b'E', b'L', b'F']) {
        return SniffedMime::ElfExecutable;
    }
    if bytes.starts_with(&[0xCA, 0xFE, 0xBA, 0xBE]) {
        return SniffedMime::JavaArchive;
    }
    if bytes.starts_with(b"#!") {
        return SniffedMime::Script;
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return SniffedMime::Mp4;
    }
    SniffedMime::Unknown
}

const BLOCKED_EXTENSIONS: &[&str] = &[
    "exe", "dll", "msi", "com", "scr", "pif", "lnk", "msc", "cpl", "reg", "gadget", "bat", "cmd",
    "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "jar", "jnlp", "apk", "dex", "html",
    "htm", "mhtml", "svg",
];

pub fn extension_is_blocked(file_name: &str) -> bool {
    let Some(dot) = file_name.rfind('.') else {
        return false;
    };
    let ext = &file_name[dot + 1..];
    if ext.is_empty() {
        return false;
    }
    BLOCKED_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
}

pub fn strip_jpeg_metadata(jpeg: &[u8]) -> Result<Vec<u8>> {
    if !jpeg.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Err(DistorrentError::Protocol("não é um JPEG válido".into()));
    }
    let mut out = Vec::with_capacity(jpeg.len());
    out.extend_from_slice(&jpeg[..2]);
    let mut i = 2;
    while i + 4 <= jpeg.len() {
        if jpeg[i] != 0xFF {
            return Err(DistorrentError::Protocol(
                "JPEG corrompido (marker fora de lugar)".into(),
            ));
        }
        let marker = jpeg[i + 1];
        if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            out.extend_from_slice(&jpeg[i..i + 2]);
            i += 2;
            continue;
        }
        if marker == 0xD9 || marker == 0xDA {
            out.extend_from_slice(&jpeg[i..]);
            return Ok(out);
        }
        if marker == 0xFF || marker == 0x00 {
            return Err(DistorrentError::Protocol("JPEG corrompido".into()));
        }
        let len = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
        if len < 2 || i + 2 + len > jpeg.len() {
            return Err(DistorrentError::Protocol(
                "JPEG corrompido (segmento truncado)".into(),
            ));
        }
        let seg = &jpeg[i..i + 2 + len];
        let drop = matches!(marker, 0xE1 | 0xE2 | 0xED);
        if !drop {
            out.extend_from_slice(seg);
        }
        i += 2 + len;
    }
    if i != jpeg.len() {
        return Err(DistorrentError::Protocol(
            "JPEG corrompido (truncado)".into(),
        ));
    }
    Ok(out)
}

pub fn strip_png_metadata(png: &[u8]) -> Result<Vec<u8>> {
    let magic: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if !png.starts_with(magic) || png.len() < magic.len() + 8 {
        return Err(DistorrentError::Protocol("não é um PNG válido".into()));
    }
    let mut out = Vec::with_capacity(png.len());
    out.extend_from_slice(magic);
    let mut i = magic.len();
    while i + 8 <= png.len() {
        let len = u32::from_be_bytes([png[i], png[i + 1], png[i + 2], png[i + 3]]) as usize;
        if i + 12 + len > png.len() {
            return Err(DistorrentError::Protocol(
                "PNG corrompido (chunk truncado)".into(),
            ));
        }
        let ctype = &png[i + 4..i + 8];
        let chunk = &png[i..i + 12 + len];
        let drop = matches!(ctype, b"tEXt" | b"zTXt" | b"iTXt" | b"eXIf" | b"tIME");
        if !drop {
            out.extend_from_slice(chunk);
        }
        i += 12 + len;
        if ctype == b"IEND" {
            break;
        }
    }
    Ok(out)
}

pub fn strip_metadata(bytes: &[u8]) -> Result<Vec<u8>> {
    match sniff_mime(bytes) {
        SniffedMime::Jpeg => strip_jpeg_metadata(bytes),
        SniffedMime::Png => strip_png_metadata(bytes),
        _ => Ok(bytes.to_vec()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_jpeg() -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x04, 0x4A, 0x46]);
        v.extend_from_slice(&[0xFF, 0xE1, 0x00, 0x06, b'E', b'x', b'i', 0x00]);
        v.extend_from_slice(&[0xFF, 0xED, 0x00, 0x04, 0x49, 0x50]);
        v.extend_from_slice(&[0xFF, 0xDB, 0x00, 0x04, 0x01, 0x02]);
        v.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x04, 0xAA, 0xBB]);
        v.extend_from_slice(&[0x11, 0x22, 0x33]);
        v.extend_from_slice(&[0xFF, 0xD9]);
        v
    }

    #[test]
    fn jpeg_strip_remove_app1_e_app13() {
        let j = build_jpeg();
        let out = strip_jpeg_metadata(&j).unwrap();
        assert!(!out.windows(4).any(|w| w == [0xFF, 0xE1, 0x00, 0x06]));
        assert!(!out
            .windows(4)
            .any(|w| [0xFF, 0xED, 0x00, 0x04][..].iter().eq(w.iter())));
        assert!(out.windows(4).any(|w| w == [0xFF, 0xE0, 0x00, 0x04]));
        assert!(out.windows(4).any(|w| w == [0xFF, 0xDB, 0x00, 0x04]));
        assert!(out.ends_with(&[0xFF, 0xD9]));
        assert!(out.starts_with(&[0xFF, 0xD8]));
        assert_eq!(sniff_mime(&out), SniffedMime::Jpeg);
    }

    #[test]
    fn jpeg_strip_input_intacto() {
        let j = build_jpeg();
        let _ = strip_jpeg_metadata(&j).unwrap();
        assert!(j.contains(&b'E'));
    }

    #[test]
    fn png_strip_remove_text_chunks() {
        let mut v: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&[0u8; 13]);
        v.extend_from_slice(&[0u8; 4]);
        v.extend_from_slice(&8u32.to_be_bytes());
        v.extend_from_slice(b"tEXtGPS:here");
        v.extend_from_slice(&[0u8; 4]);
        v.extend_from_slice(&3u32.to_be_bytes());
        v.extend_from_slice(b"IDAT");
        v.extend_from_slice(&[9, 9, 9]);
        v.extend_from_slice(&[0u8; 4]);
        v.extend_from_slice(&0u32.to_be_bytes());
        v.extend_from_slice(b"IEND");
        v.extend_from_slice(&[0u8; 4]);
        let out = strip_png_metadata(&v).unwrap();
        assert!(!out.windows(4).any(|w| w == b"tEXt"));
        assert!(out.windows(4).any(|w| w == b"IHDR"));
        assert!(out.windows(4).any(|w| w == b"IDAT"));
        assert!(out.windows(4).any(|w| w == b"IEND"));
        assert_eq!(out.len(), v.len() - (4 + 4 + 8 + 4));
    }

    #[test]
    fn sniff_detecta_tipos_reais() {
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), SniffedMime::Jpeg);
        assert_eq!(
            sniff_mime(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
            SniffedMime::Png
        );
        assert_eq!(
            sniff_mime(&[0x4D, 0x5A, 0x90, 0x00]),
            SniffedMime::WindowsExecutable
        );
        assert_eq!(
            sniff_mime(&[0x7F, b'E', b'L', b'F', 0x02]),
            SniffedMime::ElfExecutable
        );
        assert_eq!(sniff_mime(b"#!/bin/sh\n"), SniffedMime::Script);
        assert_eq!(sniff_mime(b"%PDF-1.7"), SniffedMime::Pdf);
        assert_eq!(
            sniff_mime(&[0x00, 0x00, 0x00, 0x18, b'f', b't', b'y', b'p', 0x00, 0x00, 0x00, 0x00]),
            SniffedMime::Mp4
        );
        assert_eq!(sniff_mime(&[0x1A, 0x45, 0xDF, 0xA3]), SniffedMime::Webm);
        assert_eq!(sniff_mime(&[1, 2, 3]), SniffedMime::Unknown);
        assert!(sniff_mime(&[0x4D, 0x5A, 1, 1]).is_executable());
        assert!(!sniff_mime(b"%PDF-1.7").is_executable());
    }

    #[test]
    fn extension_blocklist() {
        for bad in [
            "setup.exe",
            "lib.DLL",
            "doc.scr",
            "run.BAT",
            "s.ps1",
            "a.vbs",
            "x.js",
            "app.jar",
            "app.apk",
            "page.html",
            "img.svg",
            "o.lnk",
            "i.msi",
        ] {
            assert!(extension_is_blocked(bad), "{bad} deveria bloquear");
        }
        for ok in [
            "foto.jpg",
            "video.mp4",
            "doc.pdf",
            "musica.ogg",
            "dados.zip",
            "sem-extensao",
            "ponto-final.",
            ".oculto",
            "nota.txt",
        ] {
            assert!(!extension_is_blocked(ok), "{ok} não deveria bloquear");
        }
    }

    #[test]
    fn jar_e_script_sao_executaveis() {
        assert!(SniffedMime::JavaArchive.is_executable());
        assert!(SniffedMime::Script.is_executable());
        assert!(SniffedMime::Zip.is_executable() == false);
    }

    #[test]
    fn strip_metadata_nao_toca_video() {
        let webm = [0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3, 4];
        let out = strip_metadata(&webm).unwrap();
        assert_eq!(out, webm.to_vec());
    }

    #[test]
    fn strip_falha_limpo_em_jpeg_corrompido() {
        assert!(strip_jpeg_metadata(&[0xFF, 0xD8, 0xFF, 0x00]).is_err());
        assert!(strip_png_metadata(&[0x89, b'P']).is_err());
    }
}
