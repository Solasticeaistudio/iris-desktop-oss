#[cfg(not(target_os = "windows"))]
use image::RgbaImage;

#[derive(Debug, Clone, Copy)]
pub struct DisplayInfo {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub is_primary: bool,
    pub scale_factor: f32,
}

#[derive(Debug, Clone)]
pub struct Screen {
    pub display_info: DisplayInfo,
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{DisplayInfo, Screen};
    use image::RgbaImage;
    use std::mem::size_of;
    use win_screenshot::capture::capture_display;
    use windows::Win32::Foundation::{BOOL, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
    };
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, MONITORINFOF_PRIMARY, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    unsafe extern "system" fn collect_monitor(
        monitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let monitors = &mut *(data.0 as *mut Vec<DisplayInfo>);
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            let rect = info.rcMonitor;
            let mut dpi_x = 96;
            let mut dpi_y = 96;
            let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
            monitors.push(DisplayInfo {
                width: (rect.right - rect.left).max(0) as u32,
                height: (rect.bottom - rect.top).max(0) as u32,
                x: rect.left,
                y: rect.top,
                is_primary: info.dwFlags & MONITORINFOF_PRIMARY != 0,
                scale_factor: dpi_x as f32 / 96.0,
            });
        }
        BOOL(1)
    }

    impl Screen {
        pub fn all() -> Result<Vec<Self>, String> {
            let mut monitors = Vec::new();
            let result = unsafe {
                EnumDisplayMonitors(
                    HDC::default(),
                    None,
                    Some(collect_monitor),
                    LPARAM((&mut monitors as *mut Vec<DisplayInfo>) as isize),
                )
            };
            if !result.as_bool() {
                return Err("Windows monitor enumeration failed".to_string());
            }
            Ok(monitors
                .into_iter()
                .map(|display_info| Self { display_info })
                .collect())
        }

        pub fn capture(&self) -> Result<RgbaImage, String> {
            let (desktop, origin_x, origin_y) = capture_virtual_desktop()?;
            crop(
                &desktop,
                self.display_info.x - origin_x,
                self.display_info.y - origin_y,
                self.display_info.width,
                self.display_info.height,
            )
        }

        pub fn capture_area(
            &self,
            x: i32,
            y: i32,
            width: u32,
            height: u32,
        ) -> Result<RgbaImage, String> {
            let (desktop, origin_x, origin_y) = capture_virtual_desktop()?;
            crop(
                &desktop,
                self.display_info.x - origin_x + x,
                self.display_info.y - origin_y + y,
                width,
                height,
            )
        }
    }

    fn capture_virtual_desktop() -> Result<(RgbaImage, i32, i32), String> {
        let captured = capture_display().map_err(|error| format!("{error:?}"))?;
        let image = RgbaImage::from_raw(captured.width, captured.height, captured.pixels)
            .ok_or_else(|| "Windows capture returned an invalid image buffer".to_string())?;
        let origin_x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
        let origin_y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
        Ok((image, origin_x, origin_y))
    }

    fn crop(
        image: &RgbaImage,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    ) -> Result<RgbaImage, String> {
        let x = x.max(0) as u32;
        let y = y.max(0) as u32;
        if x >= image.width() || y >= image.height() {
            return Err("Area size is invalid".to_string());
        }
        let width = width.min(image.width() - x);
        let height = height.min(image.height() - y);
        if width == 0 || height == 0 {
            return Err("Area size is invalid".to_string());
        }
        Ok(image::imageops::crop_imm(image, x, y, width, height).to_image())
    }
}

#[cfg(not(target_os = "windows"))]
impl Screen {
    pub fn all() -> Result<Vec<Self>, String> {
        Err("Screen capture is currently supported only on Windows".to_string())
    }

    pub fn capture(&self) -> Result<RgbaImage, String> {
        Err("Screen capture is currently supported only on Windows".to_string())
    }

    pub fn capture_area(
        &self,
        _x: i32,
        _y: i32,
        _width: u32,
        _height: u32,
    ) -> Result<RgbaImage, String> {
        Err("Screen capture is currently supported only on Windows".to_string())
    }
}
