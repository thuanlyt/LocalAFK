# LocalAFK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](package.json)
[![CI](https://github.com/thuanlyt/LocalAFK/actions/workflows/ci.yml/badge.svg)](https://github.com/thuanlyt/LocalAFK/actions/workflows/ci.yml)

Bảng điều khiển web (self-hosted) cho **Discord Bot** của riêng bạn: đăng nhập, chọn server (guild), chat trực tiếp trong kênh text, và tham gia kênh voice rồi **treo 24/7** — kết nối vẫn duy trì trên server ngay cả khi bạn đóng trình duyệt, cho đến khi bạn tự bấm "Thoát phòng".

Mã nguồn mở, giấy phép MIT.

## 🚧 Trạng thái dự án

Source đã **hoàn chỉnh, có test tự động cho phần voice lifecycle, và tự deploy được ngay** theo hướng dẫn bên dưới — đã test thật với bot Discord thật, chat và giữ voice ổn định. Xem [Giới hạn hiện tại](#giới-hạn-hiện-tại) để biết trung thực những gì chưa hoàn thiện.

## Mục lục

- [Tính năng](#tính-năng)
- [Vì sao không có "self-bot"](#️-vì-sao-không-có-self-bot-đăng-nhập-bằng-tài-khoản-discord-thật)
- [Kiến trúc hoạt động](#kiến-trúc-hoạt-động)
- [Yêu cầu](#yêu-cầu)
- [Bước 1 — Tạo Discord Bot](#bước-1--tạo-discord-bot)
- [Bước 2 — (Tuỳ chọn) OAuth2](#bước-2--tuỳ-chọn-bật-đăng-nhập-discord-oauth2)
- [Cài đặt & chạy](#cài-đặt--chạy)
- [Chạy bằng Docker](#chạy-bằng-docker)
- [Host 24/7](#host-247-không-cần-bật-máy-tính-cá-nhân)
- [Sử dụng](#sử-dụng)
- [Cấu hình (.env) — tham chiếu đầy đủ](#cấu-hình-env--tham-chiếu-đầy-đủ)
- [Troubleshooting / FAQ](#troubleshooting--faq)
- [Giới hạn hiện tại](#giới-hạn-hiện-tại)
- [Bảo mật](#bảo-mật)
- [Đóng góp](#đóng-góp)
- [License](#license)

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

- Node.js ≥ 22.12 (khuyến nghị Node 24 LTS) — bắt buộc vì `@discordjs/voice` (bản đang dùng) yêu cầu tối thiểu Node 22.12.
- Một Discord Application + Bot (miễn phí, tạo trong vài phút)
- (Tuỳ chọn) Docker, nếu muốn chạy bằng container

## Bước 1 — Tạo Discord Bot

1. Vào [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**, đặt tên tuỳ ý.
2. Vào tab **Bot** → **Reset Token** → copy token, dán vào `BOT_TOKEN` trong file `.env`.
3. Trong tab **Bot**, bật **Message Content Intent** (bắt buộc để đọc nội dung tin nhắn cho tính năng chat) — quên bước này là nguyên nhân phổ biến nhất khiến bot không khởi động được (xem [Troubleshooting](#troubleshooting--faq)).
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

Chạy test:

```bash
npm test
```

## Chạy bằng Docker

```bash
docker compose up -d --build
```

`restart: unless-stopped` đảm bảo container tự khởi động lại nếu host reboot hoặc app bị crash — kết hợp với việc bot tự join lại kênh voice cũ khi khởi động, đây là cách để có một dịch vụ thực sự "24/7".

Bên trong container, app luôn bind `HOST=0.0.0.0` (được set sẵn trong `docker-compose.yml`, không cần sửa `.env`), còn cổng publish ra host chỉ mở trên `127.0.0.1:3000` — nghĩa là dashboard **không** lộ thẳng ra Internet, bạn cần tự đặt reverse proxy (Nginx/Caddy...) phía trước nếu muốn truy cập từ ngoài.

## Host 24/7 (không cần bật máy tính cá nhân)

Vài hướng phổ biến nếu bạn không muốn giữ máy tính cá nhân luôn bật:

1. **Thiết bị riêng luôn bật** (Raspberry Pi, mini PC, NAS cũ...): chạy bằng Docker hoặc trực tiếp bằng `npm start`/systemd. Toàn quyền kiểm soát, không phụ thuộc bên thứ 3, gần như miễn phí (chỉ tốn tiền điện).
2. **VPS trả phí hoặc Always-Free của các nhà cung cấp cloud** (Oracle Cloud Ampere Always Free, Google Cloud `e2-micro` Always Free, hoặc bất kỳ VPS Linux nào): triển khai native (Node 24 LTS + systemd) hoặc bằng Docker như hướng dẫn ở trên, đặt sau reverse proxy (Nginx/Caddy) để có HTTPS. Lưu ý các gói Always Free thường đông người dùng nên có thể tạm hết capacity ở một số khu vực/thời điểm — đây là giới hạn của nhà cung cấp, không phải của dự án.
3. **Dịch vụ "free Discord bot hosting" của bên thứ 3**: dễ setup nhất, nhưng bạn phải chia sẻ `BOT_TOKEN` cho một bên thứ 3 không kiểm chứng được — rủi ro token bị lộ/dùng sai mục đích, độ ổn định thường không đảm bảo. Chỉ nên dùng để test nhanh, không khuyến khích cho production.

## Sử dụng

1. Đăng nhập dashboard (OAuth hoặc mật khẩu).
2. Chọn server ở cột trái.
3. Bấm vào kênh text để chat — nhắn và nhận tin nhắn real-time.
4. Bấm vào kênh voice để bot join. Trạng thái hiển thị ở panel bên phải cùng nút **"Thoát phòng"**.
5. Bot sẽ giữ kết nối voice đó **vô thời hạn** — kể cả khi bạn đóng trình duyệt/tắt máy cá nhân (miễn là server đang chạy) — cho đến khi bạn quay lại bấm "Thoát phòng".

## Cấu hình (.env) — tham chiếu đầy đủ

| Biến | Bắt buộc | Mô tả |
|---|---|---|
| `BOT_TOKEN` | ✅ | Token của bot, lấy ở Bước 1. |
| `DISCORD_CLIENT_ID` | Tuỳ chọn | Client ID của Application, cần cho đăng nhập OAuth2. |
| `DISCORD_CLIENT_SECRET` | Tuỳ chọn | Client Secret của Application, cần cho OAuth2. |
| `DISCORD_REDIRECT_URI` | Tuỳ chọn | URL callback OAuth2, phải khớp với danh sách Redirects trong Developer Portal. |
| `OWNER_DISCORD_IDS` | Tuỳ chọn* | Danh sách Discord User ID (cách nhau dấu phẩy) được phép đăng nhập bằng OAuth2. |
| `DASHBOARD_PASSWORD` | Tuỳ chọn* | Mật khẩu đăng nhập dashboard, thay thế cho OAuth2. |
| `SESSION_SECRET` | ✅ | Chuỗi ngẫu nhiên bất kỳ để ký session cookie. |
| `COOKIE_SECURE` | Tuỳ chọn | Đặt `true` khi chạy sau HTTPS/reverse proxy thật. Mặc định `false`. |
| `PORT` | Tuỳ chọn | Cổng web server. Mặc định `3000`. |
| `HOST` | Tuỳ chọn | Địa chỉ bind của web server. Mặc định `127.0.0.1` — giữ nguyên nếu chạy native sau reverse proxy. `docker-compose.yml` tự override thành `0.0.0.0` bên trong container. |
| `DATA_DIR` | Tuỳ chọn | Thư mục lưu `state.json` (trạng thái voice để tự khôi phục sau restart). Mặc định `./data` cạnh source. Đặt path tuyệt đối (vd. `/var/lib/localafk`) nếu muốn tách state khỏi thư mục release. |

\* Cần cấu hình **ít nhất một** trong hai: OAuth2 (`DISCORD_CLIENT_ID`+`DISCORD_CLIENT_SECRET`+`DISCORD_REDIRECT_URI`+`OWNER_DISCORD_IDS`) hoặc `DASHBOARD_PASSWORD` — nếu không app sẽ báo lỗi và không khởi động (xem `src/config.js`).

## Troubleshooting / FAQ

**Bot không khởi động, báo lỗi "Used disallowed intents"**
→ Chưa bật **Message Content Intent** trong Developer Portal (Bot tab → Privileged Gateway Intents). Bật lên rồi khởi động lại.

**Bấm "Đăng nhập với Discord" bị lỗi / không redirect đúng**
→ `DISCORD_REDIRECT_URI` trong `.env` phải **khớp chính xác từng ký tự** với một URL trong danh sách Redirects ở Developer Portal (OAuth2 tab), bao gồm cả `http`/`https` và dấu `/` cuối.

**`Error: listen EADDRINUSE`**
→ Cổng 3000 (hoặc `PORT` bạn đặt) đang bị tiến trình khác chiếm. Đổi `PORT` trong `.env` hoặc tắt tiến trình đang giữ cổng đó.

**Đăng xuất khỏi dashboard sau khi restart server**
→ Bình thường — xem mục [Giới hạn hiện tại](#giới-hạn-hiện-tại). Đăng nhập lại là được, không ảnh hưởng đến bot/voice.

**Bot vào voice bị đá ra sau một thời gian**
→ Kiểm tra server Discord có cấu hình "AFK Channel timeout" quá ngắn không (Server Settings → Overview). App đã tự phát khung âm thanh im lặng để né việc này, nhưng nếu vẫn bị đá thì đây là hướng kiểm tra đầu tiên.

## Giới hạn hiện tại

Trung thực về những gì dự án **chưa** làm, để bạn không bất ngờ:

- **Session dashboard dùng store in-memory có tự dọn session hết hạn** (`memorystore`), không phải database bền vững: mỗi lần restart server (crash, deploy lại, `docker compose restart`...) thì mọi phiên đăng nhập dashboard bị xoá, cần đăng nhập lại. **Không ảnh hưởng đến bot/voice** — trạng thái voice được lưu riêng vào `DATA_DIR/state.json` (ghi atomic, xem `src/store/stateStore.js`) và tự khôi phục.
- **Trang đăng nhập bằng mật khẩu (`/auth/password`) chưa có rate limit ở tầng ứng dụng**: nếu public dashboard ra Internet, khuyến nghị dùng OAuth2 + `OWNER_DISCORD_IDS` làm phương thức chính; nếu vẫn giữ password fallback, nên thêm rate limit ở tầng reverse proxy (vd. `limit_req` của Nginx) chứ không cần thêm dependency vào app.
- **Nếu saved voice channel không còn hợp lệ khi restart** (channel/guild đã bị xoá hoặc bot bị kick khỏi guild), bot sẽ log rõ và **dừng thử kết nối lại** thay vì lặp vô hạn — trạng thái `desiredVoice` vẫn được giữ nguyên trong state file, bạn cần chủ động bấm join lại một kênh hợp lệ từ dashboard.
- Test tự động (`npm test`) hiện tập trung vào phần quan trọng nhất — vòng đời kết nối voice (`test/voiceManager.test.js`); các phần khác (auth, API, frontend) chưa có test.

Đóng góp để cải thiện các điểm trên luôn được hoan nghênh — xem mục [Đóng góp](#đóng-góp).

## Bảo mật

- Không commit file `.env` (đã có trong `.gitignore`).
- `BOT_TOKEN` cho phép toàn quyền điều khiển bot — coi như mật khẩu, không chia sẻ công khai. Nếu lộ token, vào Developer Portal **Reset Token** ngay.
- Dashboard chỉ nên public ra Internet khi đã cấu hình `OWNER_DISCORD_IDS` hoặc `DASHBOARD_PASSWORD` đủ mạnh, và nên bật HTTPS (`COOKIE_SECURE=true`) khi có domain/reverse proxy thật.
- Đăng nhập OAuth2 dùng tham số `state` ngẫu nhiên chống CSRF, và session được regenerate sau khi xác thực thành công (cả OAuth lẫn mật khẩu) để tránh session fixation.
- Đặt app sau một reverse proxy (Nginx/Caddy) khi public ra Internet: proxy lo TLS + forward HTTP/WebSocket vào `HOST:PORT` (mặc định `127.0.0.1:3000`), app không tự lo HTTPS. `GET /healthz` là endpoint không cần xác thực, dùng cho health check của proxy/service manager.
- Nguyên tắc chung: bất kỳ file nào chứa khoá/token/thông tin xác thực (SSH key, API key, cookie...) đều không nên commit vào git dù là repo private hay public — kiểm tra `.gitignore` trước khi thêm thư mục/script tự động hoá mới.

## Đóng góp

Pull request và issue đều được hoan nghênh. Vài hướng đóng góp có giá trị nhất hiện tại (xem [Giới hạn hiện tại](#giới-hạn-hiện-tại)):

1. Fork repo, tạo branch riêng cho thay đổi của bạn.
2. Giữ code style nhất quán với phần còn lại (CommonJS, không thêm dependency nặng nếu không thật cần thiết).
3. Chạy `npm test` (CI cũng tự chạy trên mọi PR) và test thủ công đầy đủ luồng chat + voice trước khi mở PR — đặc biệt nếu đổi `voiceManager.js`, hãy bổ sung test cho hành vi mới trong `test/voiceManager.test.js`.
4. Mô tả rõ trong PR: vấn đề gì được giải quyết, đã test như thế nào.

## License

[MIT](LICENSE)
