fn main() {
    println!("cargo:rustc-env=PSMUX_GIT_HASH=2c5ee95");
    println!("cargo:rustc-env=PSMUX_GIT_HASH_FULL=2c5ee9570b32a77a5c14c017b2c30d91d328de0f");
    println!("cargo:rustc-env=PSMUX_GIT_DIRTY=false");
    println!("cargo:rustc-env=PSMUX_GIT_DATE=vendored");
}
