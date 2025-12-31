fn main() {
    // Tell Cargo to rebuild if inject.js changes
    println!("cargo:rerun-if-changed=../src/scripts/inject.js");
    tauri_build::build();
}
