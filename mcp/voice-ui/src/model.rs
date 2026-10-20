use std::time::Instant;
pub const WIDTH: i32 = 480;
pub const HEIGHT: i32 = 224;
pub struct Model {
    pub session: String,
    pub state: String,
    pub mode: String,
    pub preview: String,
    elapsed_ms: u64,
    updated: Instant,
    pub pending: Option<char>,
}
impl Default for Model {
    fn default() -> Self {
        Self {
            session: String::new(),
            state: "recording".into(),
            mode: "ptt".into(),
            preview: String::new(),
            elapsed_ms: 0,
            updated: Instant::now(),
            pending: None,
        }
    }
}
impl Model {
    pub fn apply(&mut self, line: &str) -> bool {
        let p: Vec<_> = line.split('\t').collect();
        if p.len() != 6
            || p[0] != "U"
            || p[1].is_empty()
            || p[1].len() > 128
            || !p[1]
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            || !matches!(p[2], "recording" | "finalizing" | "done" | "error" | "busy")
            || !matches!(p[3], "ptt" | "agent")
        {
            return false;
        }
        let Ok(elapsed) = p[5].parse::<u64>() else {
            return false;
        };
        if self.session != p[1] {
            self.pending = None;
        }
        self.session = p[1].into();
        self.state = p[2].into();
        self.mode = p[3].into();
        self.preview = p[4]
            .chars()
            .filter(|c| !c.is_control())
            .take(16384)
            .collect();
        self.elapsed_ms = elapsed;
        self.updated = Instant::now();
        true
    }
    pub fn elapsed(&self) -> String {
        let s = self
            .elapsed_ms
            .saturating_add(self.updated.elapsed().as_millis() as u64)
            / 1000;
        format!("{:02}:{:02}", s / 60, s % 60)
    }
    pub fn can_finish(&self) -> bool {
        !self.session.is_empty()
            && self.mode == "agent"
            && self.state == "recording"
            && self.pending.is_none()
    }
    pub fn can_cancel(&self) -> bool {
        !self.session.is_empty()
            && !matches!(self.state.as_str(), "done" | "error")
            && self.pending != Some('C')
    }
    pub fn title(&self) -> &'static str {
        if self.pending == Some('C') {
            return "正在取消";
        }
        if self.pending == Some('F') && self.state == "recording" {
            return "正在结束录音";
        }
        match self.state.as_str() {
            "recording" if self.mode == "ptt" => "正在听写",
            "recording" => "正在聆听",
            "finalizing" => "正在转写",
            "busy" => "请松开语音键",
            "done" => "已完成",
            "error" => "本次语音未完成",
            _ => "语音输入",
        }
    }
    pub fn subtitle(&self) -> &'static str {
        match self.state.as_str() {
            "recording" if self.mode == "ptt" => "按住说话，松开结束",
            "recording" => "点击「说完了」，结束本次录音",
            "finalizing" => "正在整理本次语音，请稍候",
            "busy" => "松开后即可完成本次处理",
            "done" => "本次语音已处理完成",
            _ => "请结束本次会话后重试",
        }
    }
    pub fn preview_text(&self) -> String {
        if self.preview.is_empty() {
            return "说话内容会在这里实时显示…".into();
        }
        let c: Vec<_> = self.preview.chars().collect();
        if c.len() <= 160 {
            self.preview.clone()
        } else {
            format!("…{}", c[c.len() - 160..].iter().collect::<String>())
        }
    }
}
/// Physical pixel placement, confined to the foreground monitor's work area.
pub fn placement(work: [i32; 4], dpi: u32) -> [i32; 4] {
    let s = |v: i32| ((v as i64 * dpi.clamp(96, 480) as i64 + 48) / 96) as i32;
    let margin = s(24);
    let aw = (work[2] - work[0]).max(1);
    let ah = (work[3] - work[1]).max(1);
    let w = s(WIDTH).min((aw - margin * 2).max(1));
    let h = s(HEIGHT).min((ah - margin * 2).max(1));
    [
        work[2] - w - margin.min(aw - w),
        work[3] - h - margin.min(ah - h),
        w,
        h,
    ]
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ptt_has_no_finish() {
        let mut m = Model::default();
        assert!(m.apply("U\ts-1\trecording\tptt\t你好\t1250"));
        assert!(!m.can_finish());
        assert!(m.can_cancel());
        assert_eq!(m.title(), "正在听写");
        assert_eq!(m.elapsed(), "00:01");
    }
    #[test]
    fn agent_requests_are_session_scoped() {
        let mut m = Model::default();
        m.apply("U\ts-1\trecording\tagent\t你好\t0");
        assert!(m.can_finish());
        m.pending = Some('F');
        assert!(!m.can_finish());
        assert!(m.can_cancel());
        m.apply("U\ts-1\tfinalizing\tagent\t你好\t100");
        assert!(!m.can_finish());
        assert_eq!(m.title(), "正在转写");
        m.pending = Some('C');
        assert!(!m.can_cancel());
        m.apply("U\ts-2\trecording\tagent\t\t0");
        assert!(m.can_finish());
        assert_eq!(m.pending, None);
    }
    #[test]
    fn invalid_ipc_preserves_session() {
        let mut m = Model::default();
        m.apply("U\tvalid\trecording\tptt\t预览\t100");
        for bad in [
            "U\ts\trecording\tptt\tx",
            "U\ts\tunknown\tptt\tx\t1",
            "U\ts\trecording\tother\tx\t1",
            "U\ts\trecording\tptt\tx\tbad",
            "U\tbad id\trecording\tptt\tx\t1",
        ] {
            assert!(!m.apply(bad));
            assert_eq!(m.session, "valid");
            assert_eq!(m.preview, "预览");
        }
    }
    #[test]
    fn unicode_tail() {
        let mut m = Model::default();
        m.preview = "你🎤".repeat(100) + "结尾";
        let p = m.preview_text();
        assert!(p.starts_with('…'));
        assert!(p.ends_with("结尾"));
        assert_eq!(p.chars().count(), 161);
    }
    #[test]
    fn elapsed_saturates() {
        let mut m = Model::default();
        m.elapsed_ms = u64::MAX;
        assert!(m.elapsed().contains(':'));
    }
    #[test]
    fn bottom_right() {
        assert_eq!(placement([0, 0, 1920, 1040], 96), [1416, 792, 480, 224]);
    }
    #[test]
    fn negative_monitor_and_dpi() {
        for d in [96, 120, 144, 192, 288] {
            let a = [-2560, -360, 0, 1080];
            let [x, y, w, h] = placement(a, d);
            assert!(x >= a[0] && y >= a[1] && x + w <= a[2] && y + h <= a[3]);
            assert_eq!(a[2] - x - w, (24 * d / 96) as i32);
        }
    }
    #[test]
    fn small_monitor_bounds() {
        for a in [[0, 0, 320, 200], [-100, -100, -80, -80]] {
            let [x, y, w, h] = placement(a, 192);
            assert!(x >= a[0] && y >= a[1] && x + w <= a[2] && y + h <= a[3]);
        }
    }
}
