pub struct PhaseTimer {
    job_start: std::time::Instant,
    phases: Vec<PhaseRecord>,
}

struct PhaseRecord {
    name: &'static str,
    started_at: std::time::Instant,
    duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PhaseTimingEntry {
    pub phase: String,
    pub duration_ms: u64,
}

impl PhaseTimer {
    pub fn new() -> Self {
        Self {
            job_start: std::time::Instant::now(),
            phases: Vec::new(),
        }
    }

    pub fn start(&mut self, name: &'static str) {
        self.phases.push(PhaseRecord {
            name,
            started_at: std::time::Instant::now(),
            duration_ms: None,
        });
    }

    pub fn finish(&mut self, name: &'static str) {
        if let Some(record) = self
            .phases
            .iter_mut()
            .rfind(|r| r.name == name && r.duration_ms.is_none())
        {
            record.duration_ms = Some(record.started_at.elapsed().as_millis() as u64);
        }
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.job_start.elapsed().as_millis() as u64
    }

    pub fn into_timings(self) -> Vec<PhaseTimingEntry> {
        self.phases
            .into_iter()
            .filter_map(|r| {
                r.duration_ms.map(|ms| PhaseTimingEntry {
                    phase: r.name.to_owned(),
                    duration_ms: ms,
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn phase_timer_records_durations() {
        let mut timer = PhaseTimer::new();
        timer.start("scan");
        thread::sleep(Duration::from_millis(10));
        timer.finish("scan");
        timer.start("index");
        thread::sleep(Duration::from_millis(5));
        timer.finish("index");

        let timings = timer.into_timings();
        assert_eq!(timings.len(), 2);
        assert_eq!(timings[0].phase, "scan");
        assert!(timings[0].duration_ms >= 10, "scan phase too short: {}ms", timings[0].duration_ms);
        assert_eq!(timings[1].phase, "index");
        assert!(timings[1].duration_ms >= 5, "index phase too short: {}ms", timings[1].duration_ms);
    }

    #[test]
    fn unfinished_phases_are_excluded() {
        let mut timer = PhaseTimer::new();
        timer.start("scan");
        timer.start("orphan");
        timer.finish("scan");
        // "orphan" never finished

        let timings = timer.into_timings();
        assert_eq!(timings.len(), 1);
        assert_eq!(timings[0].phase, "scan");
    }

    #[test]
    fn elapsed_ms_grows_monotonically() {
        let timer = PhaseTimer::new();
        let t1 = timer.elapsed_ms();
        thread::sleep(Duration::from_millis(5));
        let t2 = timer.elapsed_ms();
        assert!(t2 >= t1);
    }
}
