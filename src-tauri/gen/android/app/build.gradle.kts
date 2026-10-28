import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Assinatura de release: `keystore.properties` (gitignored) OU variáveis de
// ambiente. Antes este arquivo — que é VERSIONADO — tinha o caminho absoluto
// de uma máquina e as senhas em texto puro: segredo no repositório e build de
// release que só funcionava naquela máquina (no CI o `storeFile` não existia e
// o gradle falhava no meio do build). Sem nenhuma das fontes, o release sai
// NÃO ASSINADO em vez de quebrar: é o caso do CI, que precisa só compilar.
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) propFile.inputStream().use { load(it) }
    fun fromEnv(env: String, prop: String) {
        System.getenv(env)?.takeIf { it.isNotBlank() }?.let { setProperty(prop, it) }
    }
    fromEnv("DISTORRENT_KEYSTORE_PATH", "storeFile")
    fromEnv("DISTORRENT_KEYSTORE_PASSWORD", "storePassword")
    fromEnv("DISTORRENT_KEY_ALIAS", "keyAlias")
    fromEnv("DISTORRENT_KEY_PASSWORD", "keyPassword")
}

// Resolve o caminho ANTES de configurar (relativo à raiz do projeto Android) e
// só usa se o arquivo existir de verdade — um `storeFile` inexistente falha
// tarde, na hora de assinar o APK.
val releaseKeystore: java.io.File? =
    keystoreProperties.getProperty("storeFile")?.let { rootProject.file(it) }?.takeIf { it.isFile }

android {
    compileSdk = 36
    namespace = "com.distorrent.app"
    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = releaseKeystore
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.distorrent.app"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (releaseKeystore != null) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")