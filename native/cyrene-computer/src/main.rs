fn main() {
    let options = match cyrene_computer::cli::parse_arguments(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{}: {}", error.code, error.message);
            std::process::exit(2);
        }
    };

    #[cfg(windows)]
    {
        if let Err(error) = cyrene_computer::runtime::run(options) {
            eprintln!("{}: {}", error.code, error.message);
            std::process::exit(1);
        }
    }

    #[cfg(not(windows))]
    {
        let _ = options;
        eprintln!("cyrene-computer only supports Windows");
        std::process::exit(1);
    }
}
