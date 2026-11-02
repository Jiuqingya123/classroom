"""生成全平台图标：build/icon.png / icon.ico / icon.icns

electron-builder 在 mac 上只认 .icns、在 Windows 上只认 .ico，
所以三种格式都从同一张 1024 PNG 派生，改图标只需要改这里再重跑：

    python scripts/make-icon.py
"""
from PIL import Image, ImageDraw, ImageFilter
import os
import struct

S = 1024
BUILD = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     'apps', 'desktop', 'build')

BG_TOP = (74, 128, 255)
BG_BOTTOM = (24, 62, 214)
BOARD = (255, 255, 255)
STROKE = (47, 107, 255)
ACCENT = (255, 190, 60)

# icns 里各尺寸对应的 OSType
ICNS_TYPES = [
    ('ic07', 128),
    ('ic08', 256),
    ('ic09', 512),
    ('ic10', 1024),
    ('ic11', 32),
    ('ic12', 64),
    ('ic13', 256),
    ('ic14', 512),
]


def gradient(size):
    img = Image.new('RGB', (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = (y / (size - 1)) ** 0.85
        d.line([(0, y), (size, y)],
               fill=tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)))
    return img


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def render():
    radius = int(S * 0.225)
    base = gradient(S).convert('RGBA')
    base.putalpha(rounded_mask(S, radius))

    # 顶部高光。必须先模糊，否则椭圆边缘会在图标上留一道硬弧线
    gloss = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(gloss).ellipse([-S * 0.35, -S * 0.80, S * 1.35, S * 0.46],
                                  fill=(255, 255, 255, 42))
    gloss = gloss.filter(ImageFilter.GaussianBlur(int(S * 0.09)))
    gloss.putalpha(Image.composite(gloss.getchannel('A'), Image.new('L', (S, S), 0),
                                   rounded_mask(S, radius)))
    base = Image.alpha_composite(base, gloss)

    # 白板投影
    bx0, by0, bx1, by1 = int(S * 0.185), int(S * 0.225), int(S * 0.815), int(S * 0.775)
    shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [bx0, by0 + int(S * 0.024), bx1, by1 + int(S * 0.024)],
        radius=int(S * 0.062), fill=(8, 24, 74, 105))
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(S * 0.024)))
    base = Image.alpha_composite(base, shadow)

    draw = ImageDraw.Draw(base)
    draw.rounded_rectangle([bx0, by0, bx1, by1], radius=int(S * 0.062), fill=BOARD)

    # 板上的勾
    w = int(S * 0.052)
    pts = [
        (int(S * 0.315), int(S * 0.520)),
        (int(S * 0.430), int(S * 0.645)),
        (int(S * 0.700), int(S * 0.352)),
    ]
    draw.line([pts[0], pts[1]], fill=STROKE, width=w, joint='curve')
    draw.line([pts[1], pts[2]], fill=STROKE, width=w, joint='curve')
    for p in pts:
        draw.ellipse([p[0] - w // 2, p[1] - w // 2, p[0] + w // 2, p[1] + w // 2], fill=STROKE)

    r = int(S * 0.030)
    cx, cy = int(S * 0.690), int(S * 0.300)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT)
    return base


def write_icns(img, path):
    """手写 icns 容器：'icns' + 总长 + 若干 [OSType + 长度 + PNG 数据]。
    比依赖 Pillow 的 icns 写入支持更可控（Pillow 的保存支持并不完整）。"""
    chunks = b''
    for ostype, size in ICNS_TYPES:
        buf = os.path.join(BUILD, f'.tmp-{size}.png')
        img.resize((size, size), Image.LANCZOS).save(buf, 'PNG')
        with open(buf, 'rb') as f:
            data = f.read()
        os.remove(buf)
        chunks += ostype.encode('ascii') + struct.pack('>I', len(data) + 8) + data
    with open(path, 'wb') as f:
        f.write(b'icns' + struct.pack('>I', len(chunks) + 8) + chunks)


def main():
    os.makedirs(BUILD, exist_ok=True)
    img = render()

    png = os.path.join(BUILD, 'icon.png')
    img.save(png, 'PNG')

    ico = os.path.join(BUILD, 'icon.ico')
    img.save(ico, 'ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    icns = os.path.join(BUILD, 'icon.icns')
    write_icns(img, icns)

    for p in (png, ico, icns):
        print(f'{p}  {os.path.getsize(p) / 1024:.1f} KB')


if __name__ == '__main__':
    main()
