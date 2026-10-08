plugins { id("com.android.application") }
android {
    namespace = "io.github.profilepilot.phone"
    compileSdk = 37
    defaultConfig {
        applicationId = "io.github.profilepilot.phone"
        minSdk = 30
        targetSdk = 35
        versionCode = 4
        versionName = "0.2.2"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    buildFeatures { buildConfig = true }
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
