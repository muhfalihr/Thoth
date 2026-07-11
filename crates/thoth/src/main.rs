/*
 * Thoth - AI-Powered Short-Form Video Strategist
 * Copyright (c) 2026 Thoth. All Rights Reserved.
 * This software is PROPRIETARY. Unauthorized use is strictly prohibited.
 */

use thoth_core::brand;

#[tokio::main]
async fn main() {
    if let Err(e) = thoth_core::run_cli().await {
        let p = brand::p();
        eprintln!("\n  {}{}{} {}{}{}", p.red, brand::ERR, p.reset, p.red, e, p.reset);
        for cause in e.chain().skip(1) {
            eprintln!("  {}{}{} {}caused by:{} {}", p.dim, brand::SPINE, p.reset, p.dim, p.reset, cause);
        }
        std::process::exit(1);
    }
}
