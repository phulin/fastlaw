use ingest::sources::usc::parser::parse_usc_xml;
use quick_xml::events::Event;
use quick_xml::Reader;
use std::time::Instant;

fn count_xml_nodes(xml: &str) -> usize {
    let mut reader = Reader::from_str(xml);
    let mut count = 0;
    loop {
        match reader.read_event() {
            Ok(Event::Eof) => break,
            Ok(_) => count += 1,
            Err(e) => panic!("XML error at position {}: {:?}", reader.error_position(), e),
        }
    }
    count
}

fn main() {
    let path = std::env::args().nth(1).expect("Usage: bench_parser <xml_file>");
    let xml = std::fs::read_to_string(&path).expect("Failed to read XML file");

    let iterations = 5;

    // Baseline: just iterate XML events
    let _ = count_xml_nodes(&xml);
    let mut baseline_durations = Vec::new();
    for i in 0..iterations {
        let start = Instant::now();
        let node_count = count_xml_nodes(&xml);
        let elapsed = start.elapsed();
        baseline_durations.push(elapsed);
        println!(
            "Baseline {}: {:.3}s ({} XML events)",
            i + 1,
            elapsed.as_secs_f64(),
            node_count,
        );
    }
    let baseline_avg =
        baseline_durations.iter().map(|d| d.as_secs_f64()).sum::<f64>() / iterations as f64;
    let baseline_min = baseline_durations
        .iter()
        .map(|d| d.as_secs_f64())
        .fold(f64::INFINITY, f64::min);
    println!("Baseline avg: {:.3}s, min: {:.3}s\n", baseline_avg, baseline_min);

    // Parser benchmark
    let _ = parse_usc_xml(&xml, "42", "");
    let mut durations = Vec::new();
    for i in 0..iterations {
        let start = Instant::now();
        let result = parse_usc_xml(&xml, "42", "");
        let elapsed = start.elapsed();
        durations.push(elapsed);
        println!(
            "Iteration {}: {:.3}s ({} levels, {} sections)",
            i + 1,
            elapsed.as_secs_f64(),
            result.levels.len(),
            result.sections.len(),
        );
    }

    let avg = durations.iter().map(|d| d.as_secs_f64()).sum::<f64>() / iterations as f64;
    let min = durations.iter().map(|d| d.as_secs_f64()).fold(f64::INFINITY, f64::min);
    println!("\nParser avg: {:.3}s, min: {:.3}s", avg, min);
    println!("Overhead vs baseline: {:.1}x", avg / baseline_avg);
}
