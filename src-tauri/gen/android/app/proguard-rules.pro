# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Plugins nativos são resolvidos por NOME via `register_android_plugin` /
# `PluginManager.load` ("com.distorrent.app.DownloadsPlugin", "...CallForegroundPlugin",
# "...UpdaterPlugin", "...CallNotificationPlugin", "...BgServicePlugin") e os
# `@Command` por REFLEXÃO. O R8 renomeia classes/métodos no release
# (`isMinifyEnabled = true`) e o registro passaria a falhar em runtime — só no
# aparelho, só na release e só quando alguém baixa um arquivo, recebe uma
# chamada ou tenta atualizar. Cada plugin novo PRECISA entrar nesta lista.
-keep class com.distorrent.app.DownloadsPlugin { *; }
-keep class com.distorrent.app.CallForegroundPlugin { *; }
-keep class com.distorrent.app.CallForegroundService { *; }
-keep class com.distorrent.app.UpdaterPlugin { *; }
-keep class com.distorrent.app.CallNotificationPlugin { *; }
-keep class com.distorrent.app.CallActionReceiver { *; }
-keep class com.distorrent.app.BackgroundConnectionService { *; }
-keep class com.distorrent.app.BgServicePlugin { *; }
-keep class com.distorrent.app.MainActivity { *; }

# `@Command`/`@TauriPlugin` são lidos por anotação em runtime.
-keepclassmembers class com.distorrent.app.** {
    @app.tauri.annotation.Command <methods>;
}
-keepattributes *Annotation*
-keepattributes RuntimeVisibleAnnotations,RuntimeVisibleParameterAnnotations

# O `CallActionReceiver` é instanciado pelo ANDROID a partir do manifesto:
# sem o construtor preservado, o broadcast de "Atender"/"Recusar" levanta
# InstantiationException com o app em segundo plano (justo quando importa).
-keepclassmembers class com.distorrent.app.CallActionReceiver {
    public <init>();
}

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile