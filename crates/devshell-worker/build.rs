fn main() {
    let proto = "../../packages/shared/src/transport/envelope/Envelope.proto";
    println!("cargo:rerun-if-changed={proto}");
    let protoc = protoc_bin_vendored::protoc_bin_path().expect("resolve vendored protoc");
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);
    config
        .compile_protos(&[proto], &["../../packages/shared/src/transport/envelope"])
        .expect("compile transport protobuf");
}
