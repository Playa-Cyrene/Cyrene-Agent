//! 截图缩放与坐标换算的纯函数。
//!
//! 模型看到的是缩小后的截图，给出的坐标也在缩小后的参照系里；
//! 这里负责把它换回主显示器的物理像素。保持无 Win32 依赖，方便单测覆盖边界。

use crate::error::{HelperError, INVALID_COORDINATES};

/// 等比缩小到最长边不超过 `max_edge`；本来就够小时不放大，放大只会增加体积而不增加信息。
pub fn fit_within(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max_edge || longest == 0 {
        return (width, height);
    }
    let scale = |value: u32| -> u32 {
        let scaled = (u64::from(value) * u64::from(max_edge) + u64::from(longest) / 2)
            / u64::from(longest);
        // 极端长宽比下短边可能被舍入为 0，那样的位图无法创建。
        (scaled as u32).max(1)
    };
    (scale(width), scale(height))
}

/// 把参照系里的一个像素映射到屏幕物理像素，取该像素对应区域的中心，
/// 这样缩放比不是整数时也不会系统性地偏向左上角。
pub fn map_to_screen(
    x: u32,
    y: u32,
    space: (u32, u32),
    screen: (u32, u32),
) -> Result<(u32, u32), HelperError> {
    let (space_width, space_height) = space;
    let (screen_width, screen_height) = screen;
    if space_width == 0 || space_height == 0 || screen_width == 0 || screen_height == 0 {
        return Err(HelperError::new(
            INVALID_COORDINATES,
            "coordinate space and screen must be non-empty",
        ));
    }
    // 越界坐标直接拒绝而不是夹到边缘：夹取会把模型的错误点击落到屏幕角落的真实控件上。
    if x >= space_width || y >= space_height {
        return Err(HelperError::new(
            INVALID_COORDINATES,
            format!("({x}, {y}) is outside the {space_width}x{space_height} screenshot"),
        ));
    }
    let map = |value: u32, space: u32, screen: u32| -> u32 {
        let mapped = (u64::from(value) * 2 + 1) * u64::from(screen) / (u64::from(space) * 2);
        (mapped as u32).min(screen - 1)
    };
    Ok((
        map(x, space_width, screen_width),
        map(y, space_height, screen_height),
    ))
}

/// SendInput 的绝对坐标把主显示器归一化到 0..=65535。
pub fn to_absolute(pixel: u32, extent: u32) -> i32 {
    if extent <= 1 {
        return 0;
    }
    let denominator = u64::from(extent - 1);
    ((u64::from(pixel.min(extent - 1)) * 65_535 + denominator / 2) / denominator) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_within_keeps_small_screens_untouched() {
        assert_eq!(fit_within(1280, 720, 1568), (1280, 720));
    }

    #[test]
    fn fit_within_scales_longest_edge_and_keeps_ratio() {
        assert_eq!(fit_within(3840, 2160, 1568), (1568, 882));
        assert_eq!(fit_within(2160, 3840, 1568), (882, 1568));
    }

    #[test]
    fn fit_within_never_collapses_short_edge_to_zero() {
        assert_eq!(fit_within(10_000, 1, 320), (320, 1));
    }

    #[test]
    fn map_to_screen_is_identity_when_sizes_match() {
        assert_eq!(map_to_screen(0, 0, (1920, 1080), (1920, 1080)), Ok((0, 0)));
        assert_eq!(
            map_to_screen(1919, 1079, (1920, 1080), (1920, 1080)),
            Ok((1919, 1079))
        );
    }

    #[test]
    fn map_to_screen_hits_the_centre_of_the_scaled_pixel() {
        // 2 倍缩放：截图像素 10 覆盖物理像素 20..=21，中心落在 21。
        assert_eq!(map_to_screen(10, 10, (960, 540), (1920, 1080)), Ok((21, 21)));
        // 最后一个截图像素必须落在屏幕内，而不是越过右下边缘。
        assert_eq!(
            map_to_screen(1567, 881, (1568, 882), (3840, 2160)),
            Ok((3838, 2158))
        );
    }

    #[test]
    fn map_to_screen_rejects_out_of_range_instead_of_clamping() {
        let error = map_to_screen(960, 0, (960, 540), (1920, 1080)).unwrap_err();
        assert_eq!(error.code, INVALID_COORDINATES);
        let error = map_to_screen(0, 0, (0, 540), (1920, 1080)).unwrap_err();
        assert_eq!(error.code, INVALID_COORDINATES);
    }

    #[test]
    fn to_absolute_covers_both_screen_edges() {
        assert_eq!(to_absolute(0, 1920), 0);
        assert_eq!(to_absolute(1919, 1920), 65_535);
        assert_eq!(to_absolute(5, 1), 0);
    }
}
