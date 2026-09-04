# LocalAFK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](package.json)

Bảng điều khiển web (self-hosted) cho **Discord Bot** của riêng bạn: đăng nhập, chọn server (guild), chat trực tiếp trong kênh text, và tham gia kênh voice rồi **treo 24/7** — kết nối vẫn duy trì trên server ngay cả khi bạn đóng trình duyệt, cho đến khi bạn tự bấm "Thoát phòng".

Mã nguồn mở, giấy phép MIT.

## 🚧 Trạng thái dự án

Source đã **hoàn chỉnh và tự deploy được ngay** theo hướng dẫn bên dưới — đã test thật với bot Discord thật, chat và giữ voice ổn định. Bản thân tác giả hiện đang tạm dừng việc tìm VPS Always Free (xem lý do trong mục [Host miễn phí 24/7](#host-miễn-phí-247-không-cần-bật-máy-tính-cá-nhân)) do chưa đủ ngân sách thêm phương thức thanh toán — không ảnh hưởng gì đến việc bạn tự clone và host riêng.

## Mục lục

- [Tính năng](#tính-năng)
- [Vì sao không có "self-bot"](#️-vì-sao-không-có-self-bot-đăng-nhập-bằng-tài-khoản-discord-thật)
- [Kiến trúc hoạt động](#kiến-trúc-hoạt-động)
- [Yêu cầu](#yêu-cầu)
- [Bước 1 — Tạo Discord Bot](#bước-1--tạo-discord-bot)
- [Bước 2 — (Tuỳ chọn) OAuth2](#bước-2--tuỳ-chọn-bật-đăng-nhập-discord-oauth2)
- [Cài đặt & chạy](#cài-đặt--chạy)
- [Chạy bằng Docker](#chạy-bằng-docker)
- [Host miễn phí 24/7](#host-miễn-phí-247-không-cần-bật-máy-tính-cá-nhân)
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

- Node.js ≥ 18.17 (khuyến nghị 20+)
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

## Chạy bằng Docker

```bash
docker compose up -d --build
```

`restart: unless-stopped` đảm bảo container tự khởi động lại nếu host reboot hoặc app bị crash — kết hợp với việc bot tự join lại kênh voice cũ khi khởi động, đây là cách để có một dịch vụ thực sự "24/7".

## Host miễn phí 24/7 (không cần bật máy tính cá nhân)

> Phần này được viết lại dựa trên **trải nghiệm thật** khi tác giả tự đi tìm VPS free cho chính dự án này — không phải lý thuyết suông.

1. **Thiết bị riêng luôn bật** (Raspberry Pi, mini PC, NAS cũ...): chạy bằng Docker hoặc `pm2 start src/index.js`. Toàn quyền kiểm soát, không phụ thuộc bên thứ 3, gần như miễn phí (chỉ tốn tiền điện). **Đây vẫn là hướng chắc ăn nhất** nếu bạn có sẵn thiết bị — không phải xếp hàng chờ đợi ai cả.
2. **Oracle Cloud Always Free**: gói Ampere (4 OCPU/24GB) **free thật, vĩnh viễn, không có bẫy** — nhưng đây cũng là lý do nó **rất đông người săn**. Ở các region phổ biến (vd. Singapore) capacity có thể **hết sạch liên tục trong nhiều ngày đến vài tuần**, và tài khoản Free Trial mặc định **chỉ được dùng 1 region duy nhất** (muốn đổi region để né chỗ hết hàng phải Upgrade lên Pay-As-You-Go — bản thân việc Upgrade không tốn phí, tài nguyên Always Free vẫn free sau khi upgrade, nhưng bắt buộc phải thêm thẻ thanh toán hợp lệ để xác minh). Nếu kiên nhẫn được thì đây vẫn là VPS free "xịn" nhất hiện có.
3. **Google Cloud `e2-micro` Always Free**: cũng free thật vĩnh viễn (chỉ ở 3 region: `us-west1`, `us-central1`, `us-east1`), nhưng tại thời điểm viết tài liệu này, nhiều người dùng (kể cả tác giả) gặp lỗi hệ thống **`OR_BACR2_44`** khi tạo billing account lần đầu — lỗi này xảy ra ở phía Google, đổi thẻ/đổi trình duyệt/thử lại đều không giúp được, và cộng đồng báo lỗi đã kéo dài nhiều tháng chưa được vá (xem thảo luận trên [Google Developer forums](https://discuss.google.dev/t/repeated-or-bacr2-44-error-during-gcp-free-trial-billing-activation-no-resolution-despite-months-of-delay/245979)). Nếu bạn không gặp lỗi này thì đây là lựa chọn tốt; nếu gặp thì chỉ còn cách chờ Google tự sửa.
4. **Dịch vụ "free Discord bot hosting" của bên thứ 3** (nhiều trang quảng cáo 24/7 miễn phí): dễ setup nhất, nhưng bạn phải chia sẻ `BOT_TOKEN` cho một bên thứ 3 không kiểm chứng được — rủi ro token bị lộ/dùng sai mục đích, và độ ổn định/tuổi thọ dịch vụ thường không đảm bảo. Chỉ nên dùng để test nhanh, không khuyến khích cho production.

**Tóm lại**: nếu có sẵn thiết bị luôn bật → dùng ngay, khỏi đọc tiếp. Nếu không → thử Oracle trước (kiên nhẫn) hoặc Google (nếu không dính bug), và luôn có thể tự động hoá việc "thử lại định kỳ tới khi có chỗ trống" bằng script scheduled task (Windows Task Scheduler / cron) gọi `oci compute instance launch` hoặc `gcloud compute instances create` lặp lại — dự án này tự chạy theo đúng hướng đó.

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

- **Session dashboard dùng bộ nhớ (in-memory)**: mỗi lần restart server (crash, deploy lại, `docker compose restart`...) thì mọi phiên đăng nhập dashboard bị xoá, cần đăng nhập lại. **Không ảnh hưởng đến bot/voice** — trạng thái voice được lưu riêng vào `data/state.json` và tự khôi phục.
- **Trang đăng nhập bằng mật khẩu (`/auth/password`) chưa có rate limit**: nếu public dashboard ra Internet, nên dùng mật khẩu đủ mạnh và cân nhắc đặt sau reverse proxy có rate limiting.
- **Chưa có bộ test tự động.**

Đóng góp để cải thiện các điểm trên luôn được hoan nghênh — xem mục [Đóng góp](#đóng-góp).

## Bảo mật

- Không commit file `.env` (đã có trong `.gitignore`).
- `BOT_TOKEN` cho phép toàn quyền điều khiển bot — coi như mật khẩu, không chia sẻ công khai. Nếu lộ token, vào Developer Portal **Reset Token** ngay.
- Dashboard chỉ nên public ra Internet khi đã cấu hình `OWNER_DISCORD_IDS` hoặc `DASHBOARD_PASSWORD` đủ mạnh, và nên bật HTTPS (`COOKIE_SECURE=true`) khi có domain/reverse proxy thật.
- Nguyên tắc chung: bất kỳ file nào chứa khoá/token/thông tin xác thực (SSH key, API key, cookie...) đều không nên commit vào git dù là repo private hay public — kiểm tra `.gitignore` trước khi thêm thư mục/script tự động hoá mới.

## Đóng góp

Pull request và issue đều được hoan nghênh. Vài hướng đóng góp có giá trị nhất hiện tại (xem [Giới hạn hiện tại](#giới-hạn-hiện-tại)):

1. Fork repo, tạo branch riêng cho thay đổi của bạn.
2. Giữ code style nhất quán với phần còn lại (CommonJS, không thêm dependency nặng nếu không thật cần thiết).
3. Test thủ công đầy đủ luồng chat + voice trước khi mở PR (dự án chưa có test tự động).
4. Mô tả rõ trong PR: vấn đề gì được giải quyết, đã test như thế nào.

## License

[MIT](LICENSE)
