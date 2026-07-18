"""One-off placeholder icon generator for the Chrome Web Store submission.
Run once locally; not shipped in the packaged extension.
"""
from PIL import Image, ImageDraw, ImageFont

SIZES = [16, 48, 128]
BG = (30, 64, 175)       # blue-800
FG = (255, 255, 255)
FONT_PATH = "C:/Windows/Fonts/arialbd.ttf"

for size in SIZES:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    radius = max(2, size // 6)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)

    font = ImageFont.truetype(FONT_PATH, int(size * 0.62))
    text = "R"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pos = ((size - tw) / 2 - bbox[0], (size - th) / 2 - bbox[1])
    draw.text(pos, text, font=font, fill=FG)

    out_path = f"c:/Users/snoop/Desktop/CDSReceipt/icons/icon{size}.png"
    img.save(out_path)
    print("wrote", out_path)
