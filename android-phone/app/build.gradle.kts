import java.util.Properties

plugins { id("com.android.application") }
val phoneVersion = Properties().apply {
    rootProject.file("version.properties").inputStream().use { load(it) }
}
val phoneVersionCode = (System.getenv("PROFILEPILOT_ANDROID_VERSION_CODE") ?: phoneVersion.getProperty("versionCode")).toInt()
val phoneVersionName = System.getenv("PROFILEPILOT_ANDROID_VERSION_NAME") ?: phoneVersion.getProperty("versionName")
require(phoneVersionCode in 1..2100000000 && phoneVersionName.matches(Regex("[0-9A-Za-z.+-]{1,80}"))) { "Invalid Android version" }
android {
    namespace = "io.github.profilepilot.phone"
    compileSdk = 37
    defaultConfig {
        applicationId = "io.github.profilepilot.phone"
        minSdk = 30
        targetSdk = 35
        versionCode = phoneVersionCode
        versionName = phoneVersionName
        buildConfigField("int", "COMPANION_PORT", "18761")
        buildConfigField("String", "PAIRING_SCHEME", "\"profilepilot\"")
        manifestPlaceholders["pairingScheme"] = "profilepilot"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    buildFeatures { buildConfig = true }
    signingConfigs {
        create("release") {
            System.getenv("ANDROID_RELEASE_KEYSTORE")?.let { storeFile = file(it) }
            storePassword = System.getenv("ANDROID_RELEASE_STORE_PASSWORD")
            keyAlias = System.getenv("ANDROID_RELEASE_KEY_ALIAS")
            keyPassword = System.getenv("ANDROID_RELEASE_KEY_PASSWORD")
        }
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-dev"
            buildConfigField("int", "COMPANION_PORT", "18763")
            buildConfigField("String", "PAIRING_SCHEME", "\"profilepilot-dev\"")
            manifestPlaceholders["pairingScheme"] = "profilepilot-dev"
        }
        getByName("release") {
            isDebuggable = false
            signingConfig = signingConfigs.getByName("release")
        }
    }
    lint { abortOnError = true }
}
dependencies {
    implementation("androidx.activity:activity:1.9.3")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
}
