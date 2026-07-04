# 🚀 Hướng dẫn Deploy FBDown lên Render.com

## Bước 1 — Tạo GitHub Repository

1. Vào **https://github.com** → Đăng nhập (hoặc tạo tài khoản)
2. Nhấn nút **"New"** (xanh lá)
3. Đặt tên repo: `fbdown` → nhấn **"Create repository"**
4. Làm theo lệnh hiện ra trên GitHub để push code lên (xem Bước 2)

---

## Bước 2 — Push code lên GitHub

Mở **Terminal / PowerShell** trong thư mục `dowvideo fb`, chạy từng lệnh:

```bash
git init
git add .
git commit -m "FBDown v1 - Facebook Video Downloader"
git branch -M main
git remote add origin https://github.com/TÊN_BẠN/fbdown.git
git push -u origin main
```

> Thay `TÊN_BẠN` bằng username GitHub của bạn

---

## Bước 3 — Deploy lên Render.com

1. Vào **https://render.com** → Đăng nhập bằng GitHub
2. Nhấn **"New +"** → chọn **"Web Service"**
3. Chọn repo **fbdown** vừa tạo → nhấn **"Connect"**
4. Điền thông tin:
   - **Name**: `fbdown` (tùy chọn)
   - **Runtime**: chọn **Docker**  ← quan trọng!
   - **Branch**: `main`
5. Nhấn **"Create Web Service"**
6. Chờ ~5 phút để Render build xong

---

## Bước 4 — Lấy link web

Sau khi build xong, Render cho link dạng:
```
https://fbdown.onrender.com
```

Chia sẻ link này cho ai cũng dùng được! 🎉

---

## ⚠️ Lưu ý quan trọng

- **Free tier của Render**: Server sẽ "ngủ" sau 15 phút không dùng
  → Lần đầu mở sẽ chờ ~30 giây để server thức dậy
- **Tải video lớn** có thể chậm do băng thông Render miễn phí giới hạn
- **Video riêng tư** vẫn không tải được (do chính sách Facebook)
