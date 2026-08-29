# LocalAFK

Bảng điều khiển web (self-hosted) cho **Discord Bot** của riêng bạn: đăng nhập, chọn server (guild), chat trực tiếp trong kênh text, và tham gia kênh voice rồi **treo 24/7** — kết nối vẫn duy trì trên server ngay cả khi bạn đóng trình duyệt, cho đến khi bạn tự bấm "Thoát phòng".

Mã nguồn mở, giấy phép MIT.

## Tính năng

- Đăng nhập dashboard bằng **Discord OAuth2** (giới hạn theo Discord User ID của bạn) hoặc bằng **mật khẩu** đơn giản.
- Liệt kê tất cả server mà bot đang tham gia, xem danh sách kênh text/voice.
- Chat đầy đủ: xem lịch sử tin nhắn, nhận tin nhắn mới real-time, gửi tin nhắn — tất cả qua bot.
- Tham gia kênh voice và **giữ kết nối vô thời hạn**: tự động phát khung âm thanh im lặng để không bị hệ thống "AFK channel timeout" của server đá ra, tự động kết nối lại nếu rớt mạng, và **tự động join lại kênh voice cũ sau khi restart server** (trạng thái được lưu vào đĩa).
- Kết nối bot chạy trong tiến trình backend, **độc lập với trình duyệt** — đóng tab, tắt máy tính cá nhân, bot vẫn treo. Chỉ dừng khi bạn bấm "Thoát phòng" trong dashboard.
- Đóng gói Docker sẵn để deploy lên bất kỳ host nào.

## ⚠️ Vì sao không có "self-bot" (đăng nhập bằng tài khoản Discord thật)?

Discord **cấm rõ ràng** việc tự động hoá tài khoản người dùng thật (gọi là *self-bot*): tự động gửi tin nhắn, tự vào voice, "treo" 24/7 bằng chính tài khoản cá nhân qua API không chính thức. Vi phạm có thể khiến tài khoản Discord của bạn bị **khoá vĩnh viễn**. Xem chính sách chính thức: [Automated User Accounts (Self-Bots)](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots).

Vì vậy toàn bộ chat/voice/24-7 trong dự án này đều thực hiện qua **bot account** (Discord Bot API chính thức) — cách duy nhất hợp lệ và ổn định lâu dài để có một "presence" tự động 24/7 trên Discord. "Đăng nhập Discord" trong dashboard chỉ dùng để **xác thực ai được quyền điều khiển bot**, không điều khiển tài khoản cá nhân của bạn.

## Kiến trúc hoạt động

```
Trình duyệt (web UI)  <──WebSocket/REST──>  Server Node.js (luôn chạy)  <──Gateway──>  Discord
                                                     │
                                              Discord Bot Client
                                              (kết nối voice + chat)
```

Client Discord bot được khởi tạo **một lần khi server khởi động** và sống độc lập với mọi phiên trình duyệt. Dashboard chỉ là một "remote control" — gửi lệnh (join/leave/gửi tin nhắn) và nhận cập nhật real-time qua Socket.IO. Vì vậy đóng trình duyệt không ảnh hưởng gì đến kết nối voice/gateway đang chạy trên server.

## Yêu cầu

- Node.js ≥ 18.17 (khuyến nghị 20+)
- Một Discord Application + Bot (miễn phí, tạo trong vài phút)
- (Tuỳ chọn) Docker, nếu muốn chạy bằng container

## Bước 1 — Tạo Discord Bot

1. Vào [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**, đặt tên tuỳ ý.
2. Vào tab **Bot** → **Reset Token** → copy token, dán vào `BOT_TOKEN` trong file `.env`.
3. Trong tab **Bot**, bật **Message Content Intent** (bắt buộc để đọc nội dung tin nhắn cho tính năng chat).
4. Vào tab **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `View Channels`, `Send Messages`, `Read Message History`, `Connect`, `Speak`
   - Copy URL được tạo ra, mở trong trình duyệt, chọn server và mời bot vào.

## Bước 2 — (Tuỳ chọn) Bật đăng nhập Discord OAuth2

Nếu muốn dùng nút "Đăng nhập với Discord" thay vì mật khẩu:

1. Trong cùng Application ở Bước 1, vào tab **OAuth2** → lấy **Client ID** và **Client Secret**.
2. Vào **Redirects**, thêm: `http://localhost:3000/auth/callback` (hoặc domain thật khi deploy).
3. Điền vào `.env`: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`.
4. Đặt `OWNER_DISCORD_IDS` = Discord User ID của bạn (bật Developer Mode trong Discord → chuột phải vào avatar → Copy User ID). Có thể liệt kê nhiều ID, cách nhau bởi dấu phẩy, nếu muốn chia sẻ quyền điều khiển.

Nếu bỏ qua bước này, chỉ cần đặt `DASHBOARD_PASSWORD` là đủ để đăng nhập.

## Cài đặt & chạy

```bash
npm install
cp .env.example .env   # rồi điền các giá trị theo Bước 1 & 2
npm start
```

Mở `http://localhost:3000`.

Chạy chế độ dev (tự restart khi sửa code):

```bash
npm run dev
```

## Chạy bằng Docker

```bash
docker compose up -d --build
```

`restart: unless-stopped` đảm bảo container tự khởi động lại nếu host reboot hoặc app bị crash — kết hợp với việc bot tự join lại kênh voice cũ khi khởi động, đây là cách để có một dịch vụ thực sự "24/7".

## Host miễn phí 24/7 (không cần bật máy tính cá nhân)

Vài lựa chọn thực tế, sắp theo mức độ tin cậy:

1. **Thiết bị riêng luôn bật** (Raspberry Pi, mini PC, NAS cũ...): chạy bằng Docker hoặc `pm2 start src/index.js`. Toàn quyền kiểm soát, không phụ thuộc bên thứ 3, gần như miễn phí (chỉ tốn tiền điện).
2. **VM free vĩnh viễn từ nhà cung cấp lớn**: [Oracle Cloud Always Free](https://www.oracle.com/cloud/free/) (có cấu hình ARM Ampere khá mạnh, miễn phí thật sự lâu dài) hoặc Google Cloud free-tier `e2-micro`. Cần tự cài Node/Docker trên VM Linux nhưng ổn định và uy tín.
3. **Dịch vụ "free Discord bot hosting" của bên thứ 3** (nhiều trang quảng cáo 24/7 miễn phí): dễ setup nhất, nhưng bạn phải chia sẻ `BOT_TOKEN` cho một bên thứ 3 không kiểm chứng được — rủi ro token bị lộ/dùng sai mục đích, và độ ổn định/tuổi thọ dịch vụ thường không đảm bảo. Chỉ nên dùng để test nhanh, không khuyến khích cho production.

## Sử dụng

1. Đăng nhập dashboard (OAuth hoặc mật khẩu).
2. Chọn server ở cột trái.
3. Bấm vào kênh text để chat — nhắn và nhận tin nhắn real-time.
4. Bấm vào kênh voice để bot join. Trạng thái hiển thị ở panel bên phải cùng nút **"Thoát phòng"**.
5. Bot sẽ giữ kết nối voice đó **vô thời hạn** — kể cả khi bạn đóng trình duyệt/tắt máy cá nhân (miễn là server đang chạy) — cho đến khi bạn quay lại bấm "Thoát phòng".

## Bảo mật

- Không commit file `.env` (đã có trong `.gitignore`).
- `BOT_TOKEN` cho phép toàn quyền điều khiển bot — coi như mật khẩu, không chia sẻ công khai. Nếu lộ token, vào Developer Portal **Reset Token** ngay.
- Dashboard chỉ nên public ra Internet khi đã cấu hình `OWNER_DISCORD_IDS` hoặc `DASHBOARD_PASSWORD` đủ mạnh, và nên bật HTTPS (`COOKIE_SECURE=true`) khi có domain/reverse proxy thật.

## License

[MIT](LICENSE)
