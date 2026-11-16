# -*- coding: utf-8 -*-
"""把 boardNN.html 渲染成 A3 300dpi 的 JPG，自动等比缩放到正好铺满。"""
import sys, pathlib
from playwright.sync_api import sync_playwright

html = sys.argv[1] if len(sys.argv) > 1 else "board02_art.html"
out  = sys.argv[2] if len(sys.argv) > 2 else "out.jpg"
W, H = 3508, 4961

with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge", headless=True)
    pg = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
    pg.goto(pathlib.Path(html).resolve().as_uri(), wait_until="networkidle")
    pg.wait_for_timeout(2500)
    h = pg.evaluate("""() => {
        const el = document.getElementById('inner');
        const kids = [...el.children].map(c => c.getBoundingClientRect().bottom);
        const bottom = Math.max(el.getBoundingClientRect().bottom, ...kids);
        return Math.ceil(bottom - el.getBoundingClientRect().top);
    }""")
    s = min(1.0, H / max(1, h))
    pg.evaluate("(s) => { document.getElementById('inner').style.transform = `scale(${s})`; }", s)
    pg.wait_for_timeout(1200)
    pg.screenshot(path=out, full_page=False)
    b.close()
    print(f"content {h}px → scale {s:.4f} → {out}")
