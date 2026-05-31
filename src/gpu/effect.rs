use bytemuck::{Pod, Zeroable};

use super::context::GpuContext;

// ── ColorParams (matches color.wgsl uniform layout exactly) ───────────────────

/// Color grading parameters — mirrors `ColorParams` in color.wgsl.
/// All fields that are `vec3<f32>` in WGSL need 16-byte alignment → pad to vec4.
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct ColorParams {
    pub brightness:  f32,
    pub contrast:    f32,
    pub saturation:  f32,
    pub temperature: f32,
    pub tint:        f32,
    pub highlights:  f32,
    pub shadows:     f32,
    pub whites:      f32,

    pub blacks:      f32,
    pub _pad0:       [f32; 3],

    // HSL per-channel: (hue_shift°, sat_delta [-100..100], lum_delta [-100..100], _pad)
    pub hsl_red:     [f32; 4],
    pub hsl_orange:  [f32; 4],
    pub hsl_yellow:  [f32; 4],
    pub hsl_green:   [f32; 4],
    pub hsl_cyan:    [f32; 4],
    pub hsl_blue:    [f32; 4],
    pub hsl_purple:  [f32; 4],
    pub hsl_magenta: [f32; 4],

    // Log color wheels: RGBA = R/G/B shift + saturation delta, range [-1..1]
    pub wheel_shadow:    [f32; 4],
    pub wheel_midtone:   [f32; 4],
    pub wheel_highlight: [f32; 4],
    pub wheel_offset:    [f32; 4],
    pub wheel_range_lo:  f32,
    pub wheel_range_hi:  f32,
    pub wheel_intensity: f32,
    pub _pad1:           f32,

    pub sharpen:     f32,
    pub vignette:    f32,
    pub lut_enabled: u32,
    pub _pad2:       f32,

    pub _pad3:       [f32; 3],
    pub _pad4:       f32,
}

impl Default for ColorParams {
    fn default() -> Self {
        Self {
            brightness:  0.0,
            contrast:    0.0,
            saturation:  0.0,
            temperature: 0.0,
            tint:        0.0,
            highlights:  0.0,
            shadows:     0.0,
            whites:      0.0,
            blacks:      0.0,
            _pad0: [0.0; 3],
            hsl_red:     [0.0; 4],
            hsl_orange:  [0.0; 4],
            hsl_yellow:  [0.0; 4],
            hsl_green:   [0.0; 4],
            hsl_cyan:    [0.0; 4],
            hsl_blue:    [0.0; 4],
            hsl_purple:  [0.0; 4],
            hsl_magenta: [0.0; 4],
            wheel_shadow:    [0.0; 4],
            wheel_midtone:   [0.0; 4],
            wheel_highlight: [0.0; 4],
            wheel_offset:    [0.0; 4],
            wheel_range_lo:  0.333,
            wheel_range_hi:  0.550,
            wheel_intensity: 1.0,
            _pad1: 0.0,
            sharpen:     0.0,
            vignette:    0.0,
            lut_enabled: 0,
            _pad2: 0.0,
            _pad3: [0.0; 3],
            _pad4: 0.0,
        }
    }
}

impl ColorParams {
    /// Returns `true` if all parameters are identity (no processing needed).
    pub fn is_identity(&self) -> bool {
        self.brightness  == 0.0 && self.contrast    == 0.0 &&
        self.saturation  == 0.0 && self.temperature == 0.0 &&
        self.tint        == 0.0 && self.highlights  == 0.0 &&
        self.shadows     == 0.0 && self.whites      == 0.0 &&
        self.blacks      == 0.0 && self.sharpen     == 0.0 &&
        self.vignette    == 0.0 && self.lut_enabled == 0
    }
}

// ── TransitionParams (matches transition.wgsl uniform layout) ─────────────────

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct TransitionParams {
    pub progress:      f32,
    pub transition_id: u32,
    pub smoothness:    f32,
    pub _pad:          f32,
}

impl TransitionParams {
    pub fn new(progress: f32, transition_id: u32) -> Self {
        Self { progress, transition_id, smoothness: 0.02, _pad: 0.0 }
    }
}

// Transition IDs must match constants in transition.wgsl
impl crate::edit::transition::Transition {
    pub fn wgsl_id(&self) -> u32 {
        use crate::edit::transition::Transition::*;
        match self {
            Fade          => 0,
            Blink         => 1,
            Dissolve      => 2,
            WipeLeft      => 3,
            WipeRight     => 4,
            WipeUp        => 5,
            WipeDown      => 6,
            SlideLeft     => 7,
            SlideRight    => 8,
            ZoomIn        => 9,
            CircleOpen    => 10,
            CircleClose   => 11,
            Pixelize      => 12,
            Radial        => 13,
            HBlur         => 14,
            FadeGrays     => 15,
            DiagTl        => 16,
            CoverLeft     => 17,
            RevealLeft    => 18,
            SqueezeH      => 19,
            SmoothLeft    => 20,
            None          => u32::MAX,
            // Map remaining variants to closest equivalent
            WipeTopLeft   => 16,
            WipeTopRight  => 3,
            WipeBottomLeft  => 6,
            WipeBottomRight => 5,
            SlideUp       => 5,
            SlideDown     => 6,
            SmoothRight   => 4,
            SmoothUp      => 5,
            SmoothDown    => 6,
            CoverRight    => 8,
            CoverUp       => 5,
            CoverDown     => 6,
            RevealRight   => 4,
            RevealUp      => 5,
            RevealDown    => 6,
            CircleCrop    => 10,
            VertOpen      => 5,
            VertClose     => 6,
            HorzOpen      => 7,
            HorzClose     => 8,
            RectCrop      => 10,
            SqueezeV      => 19,
            HlWind        => 14,
            HrWind        => 14,
            VuWind        => 14,
            VdWind        => 14,
            HlSlice       => 3,
            HrSlice       => 4,
            VuSlice       => 5,
            VdSlice       => 6,
            DiagTr        => 16,
            DiagBl        => 16,
            DiagBr        => 16,
        }
    }
}

// ── ColorPipeline ─────────────────────────────────────────────────────────────

/// GPU pipeline for color grading a single frame.
pub struct ColorPipeline {
    pipeline:    wgpu::RenderPipeline,
    bind_layout: wgpu::BindGroupLayout,
    sampler:     wgpu::Sampler,
    // 1x1 transparent dummy LUT texture (used when lut_enabled=0)
    dummy_lut:   wgpu::Texture,
}

impl ColorPipeline {
    pub fn new(ctx: &GpuContext) -> Self {
        let shader = ctx.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label:  Some("color_shader"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("shaders/color.wgsl").into()
            ),
        });

        let bind_layout = ctx.device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label:   Some("color_bgl"),
                entries: &[
                    // 0: ColorParams uniform
                    wgpu::BindGroupLayoutEntry {
                        binding:    0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty:                 wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size:   None,
                        },
                        count: None,
                    },
                    // 1: input texture
                    wgpu::BindGroupLayoutEntry {
                        binding:    1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type:    wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled:   false,
                        },
                        count: None,
                    },
                    // 2: sampler
                    wgpu::BindGroupLayoutEntry {
                        binding:    2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                    // 3: LUT 3D texture
                    wgpu::BindGroupLayoutEntry {
                        binding:    3,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type:    wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D3,
                            multisampled:   false,
                        },
                        count: None,
                    },
                    // 4: LUT sampler
                    wgpu::BindGroupLayoutEntry {
                        binding:    4,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            }
        );

        let layout = ctx.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label:                Some("color_pl_layout"),
            bind_group_layouts:   &[&bind_layout],
            push_constant_ranges: &[],
        });

        let pipeline = ctx.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label:        Some("color_pipeline"),
            layout:       Some(&layout),
            vertex:       wgpu::VertexState {
                module:      &shader,
                entry_point: "vs_main",
                buffers:     &[],
                compilation_options: Default::default(),
            },
            fragment:     Some(wgpu::FragmentState {
                module:      &shader,
                entry_point: "fs_main",
                targets:     &[Some(wgpu::ColorTargetState {
                    format:     wgpu::TextureFormat::Rgba8Unorm,
                    blend:      None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive:    wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample:  wgpu::MultisampleState::default(),
            multiview:    None,
            cache:        None,
        });

        let sampler = ctx.linear_sampler();

        // 1×1×1 dummy LUT (returns input unchanged when lut_enabled=0)
        let dummy_lut = ctx.device.create_texture(&wgpu::TextureDescriptor {
            label:           Some("dummy_lut"),
            size:            wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count:    1,
            dimension:       wgpu::TextureDimension::D3,
            format:          wgpu::TextureFormat::Rgba8Unorm,
            usage:           wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats:    &[],
        });
        ctx.queue.write_texture(
            dummy_lut.as_image_copy(),
            &[255u8, 0, 0, 255],
            wgpu::ImageDataLayout {
                offset: 0, bytes_per_row: Some(4), rows_per_image: Some(1),
            },
            wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        );

        Self { pipeline, bind_layout, sampler, dummy_lut }
    }

    /// Apply color grading to a single frame.
    /// Returns the processed RGBA bytes.
    pub async fn apply(
        &self,
        ctx:    &GpuContext,
        frame:  &[u8],
        width:  u32,
        height: u32,
        params: &ColorParams,
        lut:    Option<&wgpu::Texture>,
    ) -> Vec<u8> {
        use wgpu::util::DeviceExt;

        let input_tex = ctx.texture_from_rgba("color_in", width, height, frame);
        let output    = ctx.render_target("color_out", width, height);

        let param_buf = ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label:    Some("color_params"),
            contents: bytemuck::bytes_of(params),
            usage:    wgpu::BufferUsages::UNIFORM,
        });

        let lut_tex  = lut.unwrap_or(&self.dummy_lut);
        let lut_view = lut_tex.create_view(&Default::default());
        let in_view  = input_tex.create_view(&Default::default());
        let out_view = output.create_view(&Default::default());

        let bind_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label:   Some("color_bg"),
            layout:  &self.bind_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: param_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&in_view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&lut_view) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });

        let mut enc = ctx.device.create_command_encoder(
            &wgpu::CommandEncoderDescriptor { label: Some("color_enc") }
        );
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("color_pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view:           &out_view,
                    resolve_target: None,
                    ops:            wgpu::Operations {
                        load:  wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..3, 0..1); // full-screen triangle
        }
        ctx.queue.submit(Some(enc.finish()));

        ctx.readback(&output, width, height).await
    }
}

// ── TransitionPipeline ────────────────────────────────────────────────────────

/// GPU pipeline for blending two frames with a transition effect.
pub struct TransitionPipeline {
    pipeline:    wgpu::RenderPipeline,
    bind_layout: wgpu::BindGroupLayout,
    sampler:     wgpu::Sampler,
}

impl TransitionPipeline {
    pub fn new(ctx: &GpuContext) -> Self {
        let shader = ctx.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label:  Some("transition_shader"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("shaders/transition.wgsl").into()
            ),
        });

        let bind_layout = ctx.device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label:   Some("tr_bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0, visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false, min_binding_size: None,
                        }, count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1, visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        }, count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2, visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        }, count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 3, visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            }
        );

        let layout = ctx.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label:                Some("tr_pl_layout"),
            bind_group_layouts:   &[&bind_layout],
            push_constant_ranges: &[],
        });

        let pipeline = ctx.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label:  Some("tr_pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module:      &shader,
                entry_point: "vs_main",
                buffers:     &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module:      &shader,
                entry_point: "fs_main",
                targets:     &[Some(wgpu::ColorTargetState {
                    format:     wgpu::TextureFormat::Rgba8Unorm,
                    blend:      None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive:     wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample:   wgpu::MultisampleState::default(),
            multiview:     None,
            cache:         None,
        });

        Self { pipeline, bind_layout, sampler: ctx.linear_sampler() }
    }

    /// Blend frame_a and frame_b at the given progress (0.0=A, 1.0=B).
    pub async fn blend(
        &self,
        ctx:     &GpuContext,
        frame_a: &[u8],
        frame_b: &[u8],
        width:   u32,
        height:  u32,
        params:  TransitionParams,
    ) -> Vec<u8> {
        use wgpu::util::DeviceExt;

        let tex_a  = ctx.texture_from_rgba("tr_a", width, height, frame_a);
        let tex_b  = ctx.texture_from_rgba("tr_b", width, height, frame_b);
        let output = ctx.render_target("tr_out", width, height);

        let param_buf = ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label:    Some("tr_params"),
            contents: bytemuck::bytes_of(&params),
            usage:    wgpu::BufferUsages::UNIFORM,
        });

        let view_a   = tex_a.create_view(&Default::default());
        let view_b   = tex_b.create_view(&Default::default());
        let out_view = output.create_view(&Default::default());

        let bind_group = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label:   Some("tr_bg"),
            layout:  &self.bind_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: param_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view_a) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&view_b) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });

        let mut enc = ctx.device.create_command_encoder(
            &wgpu::CommandEncoderDescriptor { label: Some("tr_enc") }
        );
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("tr_pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view:           &out_view,
                    resolve_target: None,
                    ops:            wgpu::Operations {
                        load:  wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        ctx.queue.submit(Some(enc.finish()));

        ctx.readback(&output, width, height).await
    }
}
