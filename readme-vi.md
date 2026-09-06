# LocalAFK

[![Giấy phép: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](package.json)
[![CI](https://github.com/thuanlyt/LocalAFK/actions/workflows/ci.yml/badge.svg)](https://github.com/thuanlyt/LocalAFK/actions/workflows/ci.yml)

[English](./README.md) | **Tiếng Việt**

LocalAFK là dashboard web tự host cho Discord bot. Bạn có thể dùng dashboard để xem các guild của bot, đọc và gửi tin nhắn trong kênh text, đồng thời giữ bot kết nối với một kênh voice trong thời gian tiến trình server còn chạy.

Dự án sử dụng Discord Bot API chính thức. LocalAFK không tự động hóa tài khoản Discord cá nhân và không phải self-bot.

## Nội dung

- [LocalAFK là gì?](#localafk-là-gì)
- [Tính năng chính](#tính-năng-chính)
- [Cách hoạt động](#cách-hoạt-động)
- [Yêu cầu](#yêu-cầu)
- [Cài đặt nhanh](#cài-đặt-nhanh)
- [Cấu hình](#cấu-hình)
- [Xác thực](#xác-thực)
- [Hành vi và lưu trạng thái voice](#hành-vi-và-lưu-trạng-thái-voice)
- [Chạy local](#chạy-local)
- [Docker](#docker)
- [Lưu ý bảo mật](#lưu-ý-bảo-mật)
- [Kiểm thử](#kiểm-thử)
- [Cấu trúc dự án](#cấu-trúc-dự-án)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Giới hạn hiện tại](#giới-hạn-hiện-tại)
- [Đóng góp](#đóng-góp)
- [Giấy phép](#giấy-phép)
- [Ủng hộ dự án](#-ủng-hộ-dự-án)

## LocalAFK là gì?

LocalAFK là một service Node.js nhỏ gọn, chạy Discord bot và dashboard trong cùng một tiến trình. Dashboard độc lập với trình duyệt: đóng tab không làm bot ngắt kết nối khỏi Discord.

Voice manager gửi một luồng Opus im lặng đều đặn, xử lý reconnect với backoff có giới hạn, và lưu guild/channel được yêu cầu để có thể khôi phục sau khi tiến trình restart.

## Tính năng chính

- Đăng nhập Discord OAuth2, giới hạn theo Discord user ID được cấu hình.
- Đăng nhập bằng mật khẩu tùy chọn để dùng private hoặc làm phương án dự phòng.
- Xem danh sách guild và channel qua dashboard web.
- Xem tin nhắn gần đây và nhận cập nhật kênh text theo thời gian thực.
- Gửi tin nhắn qua bot, có giới hạn 2.000 ký tự của Discord.
- Join, leave voice, cập nhật thành viên trực tiếp và tự reconnect.
- Lưu atomic voice target mong muốn trong `DATA_DIR/state.json`.
- Kiểm tra OAuth `state` gắn với session và regenerate session sau đăng nhập.
- `GET /healthz` để kiểm tra process còn sống.
- Hỗ trợ chạy bằng Node.js hoặc Docker.

## Cách hoạt động

```text
Trình duyệt
  │ REST + Socket.IO
  ▼
Express dashboard ── StateStore (DATA_DIR/state.json)
  │
  ▼
Discord.js client ── Discord Gateway / REST / Voice
```

Discord client khởi động một lần với các intent cần thiết cho guild, message, message content và voice state. Express phục vụ dashboard tĩnh và API có xác thực. Socket.IO gửi message mới, voice status, danh sách thành viên voice và log vận hành tới các dashboard client đã đăng nhập.

Ứng dụng không dùng database hoặc dịch vụ session bên ngoài. Session dùng `memorystore` với cơ chế dọn session hết hạn định kỳ và được chủ ý lưu trong memory.

## Yêu cầu

- Node.js `>=22.12.0`. Khuyến nghị Node.js 24 LTS.
- npm tương thích với bản Node.js đang dùng.
- Một Discord application có bot token.
- Một server nơi bot có quyền truy cập các guild/channel cần quản lý.
- Docker là tùy chọn.

Khi tạo bot, hãy bật **Message Content Intent** trong Discord Developer Portal. Cấp cho bot tối thiểu các quyền phù hợp với nhu cầu: View Channels, Read Message History, Send Messages, Connect và Speak.

## Cài đặt nhanh

```bash
git clone https://github.com/thuanlyt/LocalAFK.git
cd LocalAFK
npm ci
cp .env.example .env
npm start
```

Trên Windows PowerShell, có thể copy file bằng:

```powershell
Copy-Item .env.example .env
```

Điền `.env` trước khi khởi động service. Sau khi chạy, mở <http://127.0.0.1:3000>.

Phải cấu hình ít nhất một phương thức đăng nhập: Discord OAuth2 hoặc `DASHBOARD_PASSWORD`.

## Cấu hình

| Biến | Bắt buộc | Mô tả |
| --- | --- | --- |
| `BOT_TOKEN` | Có | Token Discord bot. Hãy coi đây là mật khẩu. |
| `SESSION_SECRET` | Có | Giá trị random dài dùng để ký session cookie. |
| `DISCORD_CLIENT_ID` | OAuth | Client ID của Discord application. |
| `DISCORD_CLIENT_SECRET` | OAuth | Client secret của Discord application. |
| `DISCORD_REDIRECT_URI` | OAuth | URL callback chính xác đã đăng ký trong Discord Developer Portal. |
| `OWNER_DISCORD_IDS` | OAuth | Danh sách Discord user ID được phép đăng nhập OAuth, phân cách bằng dấu phẩy. |
| `DASHBOARD_PASSWORD` | Mật khẩu | Bật form đăng nhập mật khẩu khi có giá trị. |
| `COOKIE_SECURE` | Không | Đặt `true` khi dashboard chạy qua HTTPS. Mặc định là `false`. |
| `PORT` | Không | Cổng web. Mặc định `3000`. |
| `HOST` | Không | Địa chỉ bind. Mặc định `127.0.0.1`. Docker Compose đặt thành `0.0.0.0` bên trong container. |
| `DATA_DIR` | Không | Thư mục chứa `state.json`. Mặc định `./data`. |

OAuth chỉ được bật khi có đủ các giá trị OAuth và ít nhất một owner ID. Service sẽ thoát ngay lúc khởi động nếu thiếu `BOT_TOKEN`, `SESSION_SECRET`, hoặc không có phương thức đăng nhập nào.

Tạo session secret bằng:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Với OAuth, đăng ký callback như `http://127.0.0.1:3000/auth/callback` hoặc URL HTTPS mà reverse proxy sử dụng. Giá trị này phải khớp chính xác với `DISCORD_REDIRECT_URI`.

## Xác thực

### Discord OAuth2

Route login tạo một giá trị `state` random bằng cryptography, gắn với session và lưu session trước khi redirect sang Discord. Callback từ chối state bị thiếu hoặc không khớp trước khi đổi authorization code, sau đó regenerate và save authenticated session rồi mới redirect về dashboard.

Callback cũng kiểm tra Discord user ID nhận được với danh sách `OWNER_DISCORD_IDS`.

### Mật khẩu dự phòng

Khi đặt `DASHBOARD_PASSWORD`, dashboard sẽ hiển thị form đăng nhập bằng mật khẩu. Đăng nhập thành công sẽ regenerate và save session trước khi trả về thành công.

Endpoint mật khẩu chưa có rate limiter ở tầng ứng dụng. Nếu mở ra Internet, nên ưu tiên OAuth với owner allowlist và thêm rate limit ở reverse proxy.

## Hành vi và lưu trạng thái voice

- Chọn một kênh voice sẽ lưu target mong muốn và kết nối bot.
- Bot phát các frame Opus im lặng đều đặn để giữ connection voice hoạt động.
- Disconnect bất ngờ dùng exponential reconnect backoff có giới hạn, bắt đầu từ 5 giây và tối đa 60 giây.
- Khi đổi kênh hoặc join lại, connection cũ được dispose mà event cũ không thể làm thay đổi connection mới.
- **Leave** xóa target mong muốn và state đã lưu, sau đó dừng connection.
- Khi process shutdown, connection đang chạy được dừng nhưng target mong muốn được giữ lại để startup lần sau khôi phục.
- Khi restore, guild đã mất, channel đã xóa hoặc target không phải voice sẽ được ghi log và không bị retry vô hạn.

Cơ chế này giúp bot độc lập với trình duyệt, nhưng không đảm bảo Discord, network, host hoặc process luôn sẵn sàng.

## Chạy local

Khởi động service bình thường:

```bash
npm start
```

Trong lúc phát triển, dùng Node watch mode:

```bash
npm run dev
```

Địa chỉ bind mặc định khi chạy native là `127.0.0.1`. Nếu public service, hãy terminate HTTPS ở reverse proxy, forward cả HTTP và WebSocket tới Node process local, và đặt `COOKIE_SECURE=true`.

Endpoint liveness không yêu cầu đăng nhập:

```text
GET /healthz
```

Endpoint trả HTTP 200 với `{ "ok": true }` khi web process còn sống. Nó cố ý không fail chỉ vì Discord hoặc voice đang reconnect.

## Docker

```bash
docker compose up -d --build
```

Image dùng Node 24 và cài dependency từ lockfile bằng `npm ci --omit=dev`. Compose mount `./data` vào `/app/data`, đặt `HOST=0.0.0.0` bên trong container và chỉ publish dashboard trên loopback của host tại `127.0.0.1:3000`.

Dùng reverse proxy cho public HTTPS. Cập nhật `DISCORD_REDIRECT_URI` thành callback URL public và đặt `COOKIE_SECURE=true` khi bật TLS. Không bake `.env` hoặc secret vào image.

## Lưu ý bảo mật

- Không commit `.env`, bot token, client secret, session secret hoặc dashboard password.
- Nếu bot token bị lộ, hãy reset token ngay.
- Dùng `SESSION_SECRET` random mạnh và mật khẩu đủ mạnh nếu bật password login.
- Ưu tiên OAuth2 với `OWNER_DISCORD_IDS` khi public dashboard.
- Public deployment nên chạy sau HTTPS và reverse proxy; native Node nên bind loopback.
- Giữ Docker host-published port ở loopback trừ khi bạn hiểu rõ và chủ ý public trực tiếp.
- LocalAFK dùng bot account Discord. Không dùng dự án để tự động hóa tài khoản Discord cá nhân.

## Kiểm thử

Chạy built-in Node.js test suite:

```bash
npm test
```

Test bao phủ voice lifecycle và StateStore persistence, gồm channel replacement, reconnect, leave/shutdown, snapshot khi set overlap, phục hồi sau write fail, JSON lỗi và dọn temporary file.

GitHub Actions của repository chạy `npm ci` và `npm test` trên Node 24 cho push và pull request vào `master`.

Các kiểm tra bổ sung ở local:

```bash
npm audit --omit=dev
node -e "console.log(require('node:crypto').getCiphers().includes('aes-256-gcm'))"
```

## Cấu trúc dự án

```text
src/
  config.js                 Cấu hình môi trường và kiểm tra lúc khởi động
  index.js                  Khởi động process và graceful shutdown
  discord/                  Discord client, chat, voice và silence stream
  store/stateStore.js       Lưu state JSON atomic
  web/                      Express auth/API/server và Socket.IO
public/                     Dashboard tĩnh
test/                       Các test dùng node:test
audit/                      Lịch sử review và remediation
Dockerfile                  Production image Node 24
docker-compose.yml          Workflow chạy container local
```

## Xử lý sự cố

### Bot không khởi động vì intents

Bật **Message Content Intent** trong Discord Developer Portal và kiểm tra bot đã được mời với các quyền cần thiết.

### OAuth redirect bị lỗi

Kiểm tra `DISCORD_REDIRECT_URI` khớp chính xác với OAuth2 redirect đã đăng ký trên Discord, gồm scheme, hostname, port, path và dấu slash cuối.

### Dashboard bị đăng xuất sau khi restart

Đây là hành vi bình thường. Session nằm trong memory và không được lưu qua process restart. Hãy đăng nhập lại; voice target được lưu riêng dưới `DATA_DIR`.

### Bot không reconnect được vào voice target đã lưu

Kiểm tra bot còn ở trong guild, channel còn tồn tại và là voice channel, đồng thời bot còn quyền Connect và Speak. Target không hợp lệ sẽ được ghi log; hãy join một channel hợp lệ mới từ dashboard.

### Cổng đã được sử dụng

Đổi `PORT` hoặc dừng process đang chiếm cổng. `HOST` điều khiển địa chỉ bind độc lập với `PORT`.

## Giới hạn hiện tại

- `memorystore` được chủ ý dùng trong memory. Session mất khi process restart và không phù hợp cho multi-process deployment.
- Password login không có brute-force limiter tích hợp. Khi cần, dùng OAuth owner allowlist và rate limiting ở reverse proxy.
- Auth, API và frontend có ít automated coverage hơn voice và persistence subsystem.
- Saved voice target được giữ lại khi trở nên không hợp lệ; LocalAFK không tự xóa vì owner có thể muốn sửa guild/channel rồi thử lại.
- Voice presence liên tục vẫn phụ thuộc Discord gateway, network, host, process manager và permissions.

## Đóng góp

Issue và pull request luôn được hoan nghênh.

Trước khi mở pull request:

- giữ cách tiếp cận CommonJS và ít dependency nếu không có lý do rõ ràng để thay đổi;
- chạy `npm ci` và `npm test`;
- cập nhật test khi thay đổi voice lifecycle hoặc persistence;
- mô tả thay đổi và các bước verification đã thực hiện;
- không đưa secret, local state hoặc deployment credential vào commit.

## Giấy phép

LocalAFK được phát hành theo [MIT License](LICENSE).

## 💖 Ủng hộ dự án

LocalAFK là một dự án **miễn phí và mã nguồn mở**. Nếu LocalAFK giúp bạn tiết kiệm thời gian, hãy dành cho dự án một ⭐ **Star** — điều đó giúp dự án được duy trì và tiếp tục cải thiện.

<a href="https://github.com/thuanlyt/LocalAFK/stargazers">
  <img src="https://img.shields.io/github/stars/thuanlyt/LocalAFK?style=social" alt="GitHub Stars">
</a>

### 🤝 Cộng đồng & Hỗ trợ

- 📖 [Đọc tài liệu](https://github.com/thuanlyt/LocalAFK#readme)
- 🐛 [Báo lỗi](https://github.com/thuanlyt/LocalAFK/issues)
- 🌐 [Website ThuanLYT](https://thuanlyt.id.vn)

<p align="center"><em>Built with ❤️ by ThuanLYT</em></p>
