use anyhow::{Context, Result};
use tracing::info;

/// Initialized wgpu device/queue/adapter — shared across all GPU operations.
pub struct GpuContext {
    pub device:  wgpu::Device,
    pub queue:   wgpu::Queue,
    pub adapter: wgpu::Adapter,
}

impl GpuContext {
    /// Initialize wgpu, preferring NVIDIA/AMD discrete GPU.
    /// Falls back to any available GPU, then software (Vulkan/DX12/Metal).
    pub async fn new() -> Result<Self> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::all(),
            ..Default::default()
        });

        // Try discrete GPU first (NVIDIA preferred for CapCut-like perf)
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference:       wgpu::PowerPreference::HighPerformance,
                compatible_surface:     None,
                force_fallback_adapter: false,
            })
            .await
            .context("no GPU adapter found")?;

        let info = adapter.get_info();
        info!(
            "GPU: {} ({:?}) — driver: {}",
            info.name, info.device_type, info.driver_info
        );

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label:    Some("thoth_gpu"),
                    required_features: wgpu::Features::empty(),
                    required_limits:   wgpu::Limits::default(),
                    memory_hints:      wgpu::MemoryHints::Performance,
                },
                None,
            )
            .await
            .context("failed to create GPU device")?;

        Ok(Self { device, queue, adapter })
    }

    /// RGBA bytes per pixel (always 4).
    pub const BPP: usize = 4;

    /// Create a GPU texture from raw RGBA bytes.
    pub fn texture_from_rgba(
        &self,
        label: &str,
        width: u32,
        height: u32,
        data: &[u8],
    ) -> wgpu::Texture {
        assert_eq!(data.len(), (width * height * 4) as usize);
        let tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label:           Some(label),
            size:            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count:    1,
            dimension:       wgpu::TextureDimension::D2,
            format:          wgpu::TextureFormat::Rgba8UnormSrgb,
            usage:           wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats:    &[],
        });
        self.queue.write_texture(
            tex.as_image_copy(),
            data,
            wgpu::ImageDataLayout {
                offset:         0,
                bytes_per_row:  Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        tex
    }

    /// Create a render-target texture (RGBA8, can be read back via buffer).
    pub fn render_target(&self, label: &str, width: u32, height: u32) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label:           Some(label),
            size:            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count:    1,
            dimension:       wgpu::TextureDimension::D2,
            format:          wgpu::TextureFormat::Rgba8UnormSrgb,
            usage:           wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats:    &[],
        });
        // Re-create without intermediate binding issue
        self.device.create_texture(&wgpu::TextureDescriptor {
            label:           Some(label),
            size:            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count:    1,
            dimension:       wgpu::TextureDimension::D2,
            format:          wgpu::TextureFormat::Rgba8Unorm,
            usage:           wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats:    &[],
        })
    }

    /// Read back a render target to CPU bytes (synchronous).
    pub async fn readback(&self, tex: &wgpu::Texture, width: u32, height: u32) -> Vec<u8> {
        let bytes_per_row_unpadded = width * 4;
        // wgpu requires bytes_per_row to be a multiple of 256
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let bytes_per_row_padded = (bytes_per_row_unpadded + align - 1) / align * align;

        let buf = self.device.create_buffer(&wgpu::BufferDescriptor {
            label:              Some("readback_buf"),
            size:               (bytes_per_row_padded * height) as u64,
            usage:              wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let mut enc = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("readback_enc"),
        });
        enc.copy_texture_to_buffer(
            tex.as_image_copy(),
            wgpu::ImageCopyBuffer {
                buffer: &buf,
                layout: wgpu::ImageDataLayout {
                    offset:         0,
                    bytes_per_row:  Some(bytes_per_row_padded),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        self.queue.submit(Some(enc.finish()));

        let slice  = buf.slice(..);
        let (tx, rx) = tokio::sync::oneshot::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| { let _ = tx.send(r); });
        self.device.poll(wgpu::Maintain::Wait);
        rx.await.unwrap().unwrap();

        // Strip row padding
        let padded = slice.get_mapped_range();
        let mut out = Vec::with_capacity((bytes_per_row_unpadded * height) as usize);
        for row in 0..height {
            let start = (row * bytes_per_row_padded) as usize;
            let end   = start + bytes_per_row_unpadded as usize;
            out.extend_from_slice(&padded[start..end]);
        }
        out
    }

    /// Default linear sampler.
    pub fn linear_sampler(&self) -> wgpu::Sampler {
        self.device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter:     wgpu::FilterMode::Linear,
            min_filter:     wgpu::FilterMode::Linear,
            ..Default::default()
        })
    }
}
