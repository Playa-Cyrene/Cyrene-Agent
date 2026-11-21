//! 主显示器整屏抓取 + PNG 编码。
//!
//! 与 cyrene-screenshot 的冻结帧不同，这里每次都是一次性同步抓取：
//! agent 工具调用本身就是串行的，不需要 DXGI 常驻会话带来的复杂度。

use std::{os::windows::ffi::OsStrExt, path::Path};

use windows::{
    Win32::{
        Foundation::GENERIC_WRITE,
        Graphics::{
            Gdi::{
                BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CAPTUREBLT, CreateCompatibleDC,
                CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, HALFTONE, HBITMAP,
                HDC, HGDIOBJ, RGBQUAD, ReleaseDC, SRCCOPY, SelectObject, SetBrushOrgEx,
                SetStretchBltMode, StretchBlt,
            },
            Imaging::{
                CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat32bppBGRA,
                IWICBitmapFrameEncode, IWICImagingFactory, WICBitmapEncoderNoCache,
            },
        },
        System::Com::{
            CLSCTX_INPROC_SERVER, CoCreateInstance, StructuredStorage::IPropertyBag2,
        },
        UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN},
    },
    core::PCWSTR,
};

use crate::{
    error::{CAPTURE_FAILED, ENCODE_FAILED, HelperError},
    geometry::fit_within,
};

pub struct BgraImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

fn capture_error(message: impl Into<String>) -> HelperError {
    HelperError::new(CAPTURE_FAILED, message)
}

fn encode_error(step: &str, error: windows::core::Error) -> HelperError {
    HelperError::new(ENCODE_FAILED, format!("{step} failed: {error}"))
}

/// 主显示器的物理像素尺寸。进程已声明 Per-Monitor V2，所以这里不会被 DPI 虚拟化。
pub fn primary_screen_size() -> Result<(u32, u32), HelperError> {
    // SAFETY: GetSystemMetrics 没有前置条件，也不写任何内存。
    let (width, height) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    if width <= 0 || height <= 0 {
        return Err(capture_error(format!(
            "primary display reported {width}x{height}"
        )));
    }
    Ok((width as u32, height as u32))
}

struct ScreenDc(HDC);
impl Drop for ScreenDc {
    fn drop(&mut self) {
        // SAFETY: 句柄来自 GetDC(None)，只在这里释放一次。
        unsafe {
            ReleaseDC(None, self.0);
        }
    }
}

struct MemoryDc(HDC);
impl Drop for MemoryDc {
    fn drop(&mut self) {
        // SAFETY: 句柄来自 CreateCompatibleDC，只在这里删除一次。
        unsafe {
            let _ = DeleteDC(self.0);
        }
    }
}

struct Dib(HBITMAP);
impl Drop for Dib {
    fn drop(&mut self) {
        // SAFETY: 位图来自 CreateDIBSection；Selection 先于它析构，此时已不再被选入 DC。
        unsafe {
            let _ = DeleteObject(HGDIOBJ(self.0.0));
        }
    }
}

struct Selection {
    dc: HDC,
    previous: HGDIOBJ,
}
impl Drop for Selection {
    fn drop(&mut self) {
        // SAFETY: 还原进入时保存的对象，保证 DIB 删除前不再被选中。
        unsafe {
            SelectObject(self.dc, self.previous);
        }
    }
}

/// 抓取主显示器并直接缩放到最长边不超过 `max_edge`。
/// 返回缩放后的图像与抓取时的屏幕物理尺寸。
pub fn capture_primary(max_edge: u32) -> Result<(BgraImage, (u32, u32)), HelperError> {
    let (screen_width, screen_height) = primary_screen_size()?;
    let (width, height) = fit_within(screen_width, screen_height, max_edge);
    let byte_len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| capture_error("capture buffer size overflow"))?;

    // SAFETY: GetDC(None) 返回整个桌面的 DC，由 ScreenDc 负责释放。
    let screen_dc = ScreenDc(unsafe { GetDC(None) });
    if screen_dc.0.is_invalid() {
        return Err(capture_error("GetDC returned an invalid handle"));
    }
    // SAFETY: screen_dc 有效；返回的内存 DC 由 MemoryDc 负责删除。
    let memory_dc = MemoryDc(unsafe { CreateCompatibleDC(Some(screen_dc.0)) });
    if memory_dc.0.is_invalid() {
        return Err(capture_error(
            "CreateCompatibleDC returned an invalid handle",
        ));
    }

    let bitmap_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            // 负高度 = 自上而下的 DIB，行顺序与 PNG 一致，省掉一次翻转。
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        bmiColors: [RGBQUAD::default(); 1],
    };
    let mut bits: *mut core::ffi::c_void = core::ptr::null_mut();
    // SAFETY: bitmap_info 描述合法的 32 位 DIB；bits 由系统写入，生命周期跟随返回的 HBITMAP。
    let dib = Dib(unsafe {
        CreateDIBSection(
            Some(memory_dc.0),
            &bitmap_info,
            DIB_RGB_COLORS,
            &mut bits,
            None,
            0,
        )
    }
    .map_err(|error| capture_error(format!("CreateDIBSection failed: {error}")))?);
    if bits.is_null() {
        return Err(capture_error("CreateDIBSection returned null bits"));
    }

    // SAFETY: 两个句柄都有效；previous 交给 Selection 在离开时还原。
    let previous = unsafe { SelectObject(memory_dc.0, HGDIOBJ(dib.0.0)) };
    if previous.0.is_null() || previous.0 as isize == -1 {
        return Err(capture_error("SelectObject failed"));
    }
    let selection = Selection {
        dc: memory_dc.0,
        previous,
    };

    // HALFTONE 在缩小时做区域平均，小字号文字仍可辨认；默认模式会直接丢行丢列。
    // SAFETY: memory_dc 有效；SetBrushOrgEx 是 HALFTONE 模式文档要求的配套调用。
    unsafe {
        SetStretchBltMode(memory_dc.0, HALFTONE);
        let _ = SetBrushOrgEx(memory_dc.0, 0, 0, None);
    }
    // SAFETY: 目标矩形与 DIB 尺寸一致，源矩形是主显示器范围，不会越界读写。
    let blitted = unsafe {
        StretchBlt(
            memory_dc.0,
            0,
            0,
            width as i32,
            height as i32,
            Some(screen_dc.0),
            0,
            0,
            screen_width as i32,
            screen_height as i32,
            SRCCOPY | CAPTUREBLT,
        )
    };
    if !blitted.as_bool() {
        return Err(capture_error(format!(
            "StretchBlt failed: {}",
            windows::core::Error::from_thread().message()
        )));
    }

    let mut pixels = vec![0u8; byte_len];
    // SAFETY: 自上而下的 32 位 DIB 行间无填充，bits 指向恰好 byte_len 字节，且 dib 仍存活。
    unsafe {
        core::ptr::copy_nonoverlapping(bits as *const u8, pixels.as_mut_ptr(), byte_len);
    }
    drop(selection);

    // GDI 不写 alpha 通道（全 0），不补成 255 的话 PNG 会是一张全透明的图。
    for pixel in pixels.chunks_exact_mut(4) {
        pixel[3] = 255;
    }

    Ok((
        BgraImage {
            width,
            height,
            pixels,
        },
        (screen_width, screen_height),
    ))
}

/// 用系统自带的 WIC 编码 PNG，避免为 helper 引入额外的图像依赖。
/// 调用线程必须已经初始化 COM。
pub fn encode_png(image: &BgraImage, path: &Path) -> Result<(), HelperError> {
    // SAFETY: 标准的进程内 COM 对象创建；调用线程已初始化 COM。
    let factory: IWICImagingFactory =
        unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| encode_error("CoCreateInstance(WICImagingFactory)", error))?;
    // SAFETY: 以下均为对刚创建、仅本函数持有的 WIC 对象的同步调用。
    let stream =
        unsafe { factory.CreateStream() }.map_err(|error| encode_error("CreateStream", error))?;
    let wide_path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: wide_path 以 NUL 结尾，且存活到同步调用返回之后。
    unsafe { stream.InitializeFromFilename(PCWSTR(wide_path.as_ptr()), GENERIC_WRITE.0) }
        .map_err(|error| encode_error("InitializeFromFilename", error))?;
    // SAFETY: 同上。
    let encoder = unsafe { factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null()) }
        .map_err(|error| encode_error("CreateEncoder", error))?;
    // SAFETY: stream 的生命周期覆盖 encoder 的全部使用。
    unsafe { encoder.Initialize(&stream, WICBitmapEncoderNoCache) }
        .map_err(|error| encode_error("encoder Initialize", error))?;

    let mut frame: Option<IWICBitmapFrameEncode> = None;
    let mut options: Option<IPropertyBag2> = None;
    // SAFETY: 两个出参都是合法的可写 Option。
    unsafe { encoder.CreateNewFrame(&mut frame, &mut options) }
        .map_err(|error| encode_error("CreateNewFrame", error))?;
    let frame = frame.ok_or_else(|| {
        HelperError::new(ENCODE_FAILED, "CreateNewFrame returned no frame encoder")
    })?;

    let mut pixel_format = GUID_WICPixelFormat32bppBGRA;
    let stride = image.width * 4;
    // SAFETY: 尺寸、格式与像素缓冲一致：pixels.len() == stride * height。
    unsafe {
        frame
            .Initialize(Option::<&IPropertyBag2>::None)
            .map_err(|error| encode_error("frame Initialize", error))?;
        frame
            .SetSize(image.width, image.height)
            .map_err(|error| encode_error("SetSize", error))?;
        frame
            .SetPixelFormat(&mut pixel_format)
            .map_err(|error| encode_error("SetPixelFormat", error))?;
        if pixel_format != GUID_WICPixelFormat32bppBGRA {
            return Err(HelperError::new(
                ENCODE_FAILED,
                "WIC rejected the 32bppBGRA pixel format",
            ));
        }
        frame
            .WritePixels(image.height, stride, image.pixels.as_slice())
            .map_err(|error| encode_error("WritePixels", error))?;
        frame
            .Commit()
            .map_err(|error| encode_error("frame Commit", error))?;
        encoder
            .Commit()
            .map_err(|error| encode_error("encoder Commit", error))?;
    }
    Ok(())
}
