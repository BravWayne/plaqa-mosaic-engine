# PLAQA Mosaic Engine

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![ONNX Runtime](https://img.shields.io/badge/ONNX_Runtime-Web_%26_WASM-005CED?logo=onnx&logoColor=white)](https://onnxruntime.ai/)
[![Sharp](https://img.shields.io/badge/libvips-sharp_0.33-99CC00)](https://sharp.pixelplumbing.com/)

Production computer vision, client-side Edge AI, and manufacturing fulfillment engine built to convert customer photos and typographic posters into physical 32×32 and 48×48 stud mosaic kits.

## Why I Built This (The Engineering Problem)

Turning arbitrary user uploads into physical brick mosaics that a warehouse can pack and a customer can actually assemble involves four real-world constraints that standard pixel-art downsamplers fail to handle:

1. **Restricted Physical Factory Palette:** Unlike 24-bit sRGB displays (16.7M colors), our injection-molded ABS studs are limited to **22 active round-stud SKUs** (out of a 97-color factory catalog) with no true mid-tone grays or deep maroons. Naive RGB matching destroys skin tones.
2. **Photos vs. Typography Need Opposite Math:** Portraits need controlled perceptual dithering in CIE L\*a\*b\* space so skin gradients don't band, while typographic posters and Arabic calligraphy need hard binary snapping and sub-stud kerning so letters don't blur into unreadable gray noise on a 32×32 grid.
3. **Zero-Cost Browser Inference:** Running background removal and face framing on cloud GPUs for every user preview gets expensive fast. This engine runs `u2netp.onnx` and `face-rfb320.onnx` directly inside the user's browser via WebAssembly (`onnxruntime-web`).
4. **Automated Warehouse Fulfillment:** Every processed image compiles directly into a physical **Bill of Materials (BOM)** with a +5% safety buffer, 50-piece bag rounding, a 2D JSON assembly matrix, and a 5-page A4 printable build blueprint.

---

## Architecture & Processing Pipeline

```mermaid
flowchart TD
    subgraph Ingestion["1. Pre-Processing & Browser Edge AI"]
        A["Input Image / Canvas<br/>(Raw RGBA Buffer)"] --> B["Client-Side Edge AI (cutout.ts)<br/>Serialized ONNX WASM Queue"]
        B --> B1["U²-Net-p (u2netp.onnx)<br/>320×320 Salient Foreground Mask"]
        B --> B2["RFB-320 (face-rfb320.onnx)<br/>Face Bounding Box + IoU NMS"]
        A --> C["Fast Midtone Gate<br/>analyzeMidtones() — Step-16 Sampling"]
    end

    subgraph Routing["2. Automatic Mode Router"]
        C -->|"midtoneRatio < 0.08<br/>(2-Color Poster / Text)"| D["Typography & Poster Pipeline<br/>renderCleanTwoColorMosaicBuffer()"]
        C -->|"midtoneRatio >= 0.08<br/>(Continuous-Tone Photo)"| E["Perceptual Photo Pipeline<br/>MasterMosaicEngine / renderMosaicV5()"]
    end

    subgraph GraphicPath["3A. Typographic & Poster Engine"]
        D --> D1["getTightContentBounds()<br/>2D Band Detection & UI Icon Stripping"]
        D1 --> D2["Uniform Aspect-Ratio Lock<br/>scale = min(gridSize / cropW, gridSize / cropH)"]
        D2 --> D3["Sub-Stud Kerning & Band Separation<br/>1-Stud Inter-Character Gap Guarantee"]
        D3 --> D4["50% Area-Majority Threshold (lum > 140)<br/>Zero-Noise Binary SKU Snapping"]
    end

    subgraph PhotoPath["3B. Perceptual Photo Engine"]
        E --> E1["Optical Exposure Boost<br/>Brightness 112% · Contrast 118% · Saturation 110%"]
        E1 --> E2["CIE L*a*b* (D65) Conversion<br/>rgbToLab() & CIEDE2000 Metric"]
        E2 --> E3["38% Damped Floyd–Steinberg Dithering<br/>+ Greedy ΔE Palette Optimization & Potts ICM"]
    end

    subgraph Manufacturing["4. Warehouse BOM & A4 Blueprint Compiler"]
        D4 --> F["2D SKU Matrix<br/>(32×32 / 48×48 Studs)"]
        E3 --> F
        F --> G["Warehouse BOM Aggregator<br/>+5% Safety Buffer & 50-pc Bag Ceiling"]
        G --> H["5-Page A4 Build Guide<br/>generateQuadrantInstructionsHTML()"]
        G --> I["Serialized JSON Payload<br/>2D Grid + EN/AR/ZH SKU Metadata"]
    end
