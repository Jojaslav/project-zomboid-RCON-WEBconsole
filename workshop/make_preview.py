from PIL import Image, ImageDraw, ImageFont

W, H = 1024, 1024
img = Image.new("RGB", (W, H), (18, 22, 20))
d = ImageDraw.Draw(img)
for y in range(H):
    g = int(18 + 30 * y / H)
    d.line([(0, y), (W, y)], fill=(g, g + 8, g + 4))


def font(size, bold=True):
    for name in ("segoeuib.ttf" if bold else "segoeui.ttf", "arialbd.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def center(text, y, f, fill):
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, y), text, font=f, fill=fill)


d.rounded_rectangle([90, 150, W - 90, 560], radius=28, fill=(28, 34, 31), outline=(95, 185, 120), width=6)
d.ellipse([130, 190, 160, 220], fill=(95, 185, 120))
d.text((185, 188), "pz-control", font=font(34), fill=(200, 220, 205))
for i, (a, b) in enumerate([("Players online", "12"), ("CPU", "23 %"), ("Memory", "4.1 GB"), ("RCON", "connected")]):
    y = 270 + i * 65
    d.text((150, y), a, font=font(34, False), fill=(150, 170, 155))
    w = d.textlength(b, font=font(34))
    d.text((W - 150 - w, y), b, font=font(34), fill=(235, 240, 235))

center("PROJECT ZOMBOID", 640, font(70), (235, 240, 235))
center("RCON + Web Admin Panel", 730, font(56), (95, 185, 120))
center("Web panel  -  Windows client  -  2FA", 830, font(40, False), (170, 185, 175))

img.save("preview.png")
img.resize((256, 256), Image.LANCZOS).save("preview_256.png")

img.resize((256, 256), Image.LANCZOS).save('preview.png')
