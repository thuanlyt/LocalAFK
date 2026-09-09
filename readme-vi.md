# LocalAFK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E22.12-brightgreen.svg)](package.json)
[![CI](https://github.com/thuanlyt/LocalAFK/actions/workflows/ci.yml/badge.svg)](https://github.com/thuanlyt/LocalAFK/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/thuanlyt/LocalAFK)](https://github.com/thuanlyt/LocalAFK/releases/latest)

[English](./README.md) | **Tiếng Việt**

LocalAFK là một Discord bot headless, nhẹ, được điều khiển hoàn toàn bằng slash command. Bot giữ kết nối với voice channel cho các owner được cấp quyền, khôi phục voice target đã lưu sau khi restart và hiển thị diagnostics trực tiếp trong Discord.

Dự án không có dashboard, HTTP server, browser control plane, web login, yêu cầu Docker, database hay reverse proxy.

**Bản ổn định hiện tại:** [v1.0.0](https://github.com/thuanlyt/LocalAFK/releases/tag/v1.0.0)

## Nội dung

- [LocalAFK là gì](#localafk-là-gì)
- [Vì sao headless](#vì-sao-headless)
- [Tính năng](#tính-năng)
- [Kiến trúc](#kiến-trúc)
- [Yêu cầu](#yêu-cầu)
- [Cài đặt nhanh](#cài-đặt-nhanh)
- [Cấu hình](#cấu-hình)
- [Slash command](#slash-command)
- [Lưu trạng thái voice](#lưu-trạng-thái-voice)
- [Chạy trên Linux](#chạy-trên-linux)
- [Chạy trên Windows](#chạy-trên-windows)
- [Process supervision](#process-supervision)
- [Bảo mật](#bảo-mật)
- [Kiểm thử](#kiểm-thử)
- [Cấu trúc dự án](#cấu-trúc-dự-án)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Giới hạn](#giới-hạn)
- [Releases](#releases)
- [Đóng góp](#đóng-góp)
- [Giấy phép](#giấy-phép)
- [Ủng hộ dự án](#-ủng-hộ-dự-án)

## LocalAFK là gì

LocalAFK chạy trong một process Node.js gồm:

- Discord.js client cho Gateway và application commands;
- CommandManager để đăng ký slash command, kiểm tra quyền, dispatch và cung cấp diagnostics;
- VoiceManager để duy trì voice presence và lifecycle reconnect;
- StateStore JSON nhỏ, ghi atomic, lưu voice target mong muốn.

Discord là giao diện và control plane của bot. Chỉ việc dừng process Node.js mới dừng runtime connection.

## Vì sao headless

Control plane native trong Discord giúp runtime nhỏ hơn và loại bỏ một lớp web hoàn chỉnh:

- không mở inbound TCP port;
- không có frontend hoặc browser session;
- không có OAuth web callback hoặc password UI;
- không có HTTP, Socket.IO, TLS, reverse proxy hoặc Docker layer;
- ít dependency hơn và ít Discord intent đặc quyền hơn;
- diagnostics và điều khiển vẫn ở ngay trong Discord nơi bot hoạt động.

Khi chạy lâu dài, hãy dùng process supervisor của hệ điều hành. LocalAFK không đóng gói sẵn cấu hình supervisor.

## Tính năng

- Một root slash command: /afk.
- Allowlist owner qua OWNER_DISCORD_IDS, phân tách bằng dấu phẩy.
- Response ephemeral cho control, status, sync, diagnostics và lỗi.
- Đăng ký command theo guild để thử nghiệm nhanh hoặc global cho nhiều guild.
- Startup command sync chỉ ghi lên Discord khi schema thực sự khác.
- Join, leave, reconnect, status và liệt kê thành viên voice.
- Silent Opus frames để duy trì voice connection.
- Voice lifecycle có generation guard và reconnect backoff giới hạn.
- Ghi desiredVoice atomic, có khả năng phục hồi sau lỗi ghi.
- Diagnostics an toàn cho Node version, uptime, memory, gateway ping, số guild, voice state và command sync state.
- Thống kê VPS/host read-only (`/afk stats`): CPU, RAM, swap, disk, listening port và top process — không cần SSH.
- Đọc file môi trường bằng Node.js native, không cần dependency runtime ngoài Node.js và npm.

## Kiến trúc

~~~text
Discord Gateway + Slash Commands
              │
              ▼
       LocalAFK Node.js process
              │
      ┌───────┼────────┐
      ▼       ▼        ▼
CommandManager VoiceManager StateStore
                         │
                         ▼
                 DATA_DIR/state.json
~~~

Bot chỉ yêu cầu hai intent `Guilds` và `GuildVoiceStates`. Bot không subscribe message content hoặc message events.

## Yêu cầu

- Node.js >=22.12.0; khuyến nghị Node.js 24 LTS.
- npm tương thích với Node.js đang cài.
- Một Discord application và bot token.
- Bot được invite với scope `bot` và `applications.commands`.
- Quyền truy cập guild và voice channel cần quản lý.
- Quyền Connect và Speak trong voice channel mục tiêu.

LocalAFK không cần Docker, database, HTTP port, web server hoặc reverse proxy.

## Cài đặt nhanh

~~~bash
git clone https://github.com/thuanlyt/LocalAFK.git
cd LocalAFK
npm ci
cp .env.example .env
npm start
~~~

Hãy chỉnh sửa `.env` trước khi start. Trên Windows PowerShell, copy file mẫu bằng:

~~~powershell
Copy-Item .env.example .env
~~~

Để pin checkout vào bản stable đầu tiên thay vì branch master hiện tại:

~~~bash
git checkout v1.0.0
~~~

Invite bot với scope `bot` và `applications.commands`, sau đó chạy `/afk ping` trong guild nơi Discord user ID của bạn đã có trong `OWNER_DISCORD_IDS`.

Khi phát triển:

~~~bash
npm run dev
~~~

## Cấu hình

| Biến | Bắt buộc | Mô tả |
| --- | --- | --- |
| BOT_TOKEN | Có | Discord bot token. Hãy bảo vệ như password. |
| OWNER_DISCORD_IDS | Có | Danh sách Discord user ID được phép chạy `/afk`, phân tách bằng dấu phẩy. |
| COMMAND_GUILD_ID | Không | Đăng ký command trong một guild này. Để trống nghĩa là global registration. Khi được đặt, `/afk` cũng từ chối mọi interaction đến từ guild khác ngay lúc thực thi, độc lập với scope đăng ký. |
| DATA_DIR | Không | Thư mục chứa `state.json`. Mặc định là `./data`. |
| STATS_SHOW_HOSTNAME | Không | Đặt `true` để hiển thị hostname của OS trong `/afk stats`. Mặc định ẩn, vì hostname tự đặt có thể chứa thông tin định danh/riêng tư. |

Ứng dụng yêu cầu cả `BOT_TOKEN` và ít nhất một owner ID. `COMMAND_GUILD_ID` hữu ích khi phát triển vì guild command cập nhật nhanh hơn; global command có thể cần thời gian propagate.

Chỉ tạo hoặc copy secret trong file `.env` local, giữ file này riêng tư. `.env` đã được Git ignore và tuyệt đối không được commit.

## Slash command

Tất cả `/afk` command chỉ dành cho owner. Quyền được kiểm tra runtime bằng `interaction.user.id`; interaction không được phép nhận response ephemeral và không gây side effect.

| Command | Hành vi |
| --- | --- |
| `/afk voice join channel:<voice channel>` | Validate guild/channel, lưu target và connect hoặc chuyển voice. |
| `/afk voice leave` | Xóa target đã lưu, hủy reconnect và dừng voice. |
| `/afk voice reconnect` | Giữ target đã lưu, dispose connection hiện tại và reconnect có chủ đích. |
| `/afk voice status` | Hiển thị state connected/reconnecting, target, duration và reconnect state. |
| `/afk voice members` | Liệt kê thành viên voice hiện tại, đánh dấu bot và tự cắt nội dung dài. |
| `/afk commands status` | Hiển thị scope guild/global, local count, remote count và schema sync state. |
| `/afk commands sync` | Buộc đồng bộ schema command và báo scope/count. |
| `/afk ping` | Hiển thị gateway ping và process uptime. |
| `/afk status` | Hiển thị tóm tắt bot, gateway, voice, target và command scope. |
| `/afk diagnostics` | Hiển thị operational snapshot an toàn, không có token, secret, owner ID hoặc private path. |
| `/afk stats` | Hiển thị thống kê hệ thống VPS/host read-only: CPU, RAM, swap, disk, listening port và top process. |

Response điều khiển và diagnostics đều là ephemeral. Handler voice gọi public API của VoiceManager, không sao chép voice lifecycle logic.

### /afk stats

`/afk stats` cho phép owner quan sát sức khỏe VPS/host trực tiếp từ Discord, không cần SSH. Lệnh này:

- **chỉ đọc** — không bao giờ exec shell, không nhận command tùy ý, không thể kill/restart/reboot hay sửa bất kỳ file nào;
- **owner-only và ephemeral** như mọi command `/afk` khác, và bị giới hạn theo guild khi `COMMAND_GUILD_ID` được cấu hình;
- **có rate-limit** — tối đa 1 lần mỗi 5 giây cho mỗi owner, tránh gọi `ps`/`ss` lặp lại không cần thiết;
- **được redact có chủ đích** — không bao giờ hiển thị remote peer IP (chỉ có số "Established connections: N"), không hiển thị argv/environment/cwd của process (chỉ pid, CPU%, MEM% và tên executable), và hostname của OS bị ẩn trừ khi đặt rõ `STATS_SHOW_HOSTNAME=true`.

Lệnh không mở HTTP port, không khởi động monitoring server, không thêm web dashboard — Discord vẫn là control plane duy nhất. Trên Linux, lệnh đọc `/proc`, các hàm built-in của `os`, và hai executable cố định `ps`/`ss` với tham số cố định qua `execFile` (không bao giờ dùng chuỗi shell); trên các nền tảng khác (kể cả Windows), phần port/process báo "Unavailable on this platform" thay vì đoán mò hay crash, trong khi CPU/RAM/disk/thống kê process LocalAFK vẫn khả dụng ở bất cứ đâu `fs.statfs`/`os` hỗ trợ.

### Đăng ký command

Khi startup, LocalAFK build schema `/afk` local, fetch command remote trong scope đã cấu hình, normalize các field liên quan rồi compare. Nếu giống nhau, đăng ký là no-op. Nếu khác, LocalAFK replace command set bằng schema local.

- Có `COMMAND_GUILD_ID`: đăng ký command trong guild đó.
- `COMMAND_GUILD_ID` trống: đăng ký command global.
- `/afk commands sync`: buộc đồng bộ.
- `/afk commands status`: xem kết quả so sánh hiện tại mà không mutate Discord.

Bot không hot-reload source code. Sau khi đổi application, hãy restart process Node.js; chỉ dùng `/afk commands sync` cho việc đăng ký command.

## Lưu trạng thái voice

- `/afk voice join` kiểm tra channel voice/stage trong guild của interaction trước khi lưu.
- VoiceManager gửi silent Opus stream ổn định.
- Disconnect bất ngờ sẽ reconnect với backoff giới hạn từ 5 giây đến 60 giây.
- Generation guard ngăn event và timer cũ ảnh hưởng connection mới.
- `/afk voice reconnect` giữ desiredVoice và chủ động thay connection hiện tại.
- `/afk voice leave` xóa desiredVoice và không reconnect.
- Shutdown process dừng runtime connection nhưng giữ desiredVoice cho startup sau.
- Guild/channel đã lưu nhưng không còn hợp lệ sẽ được log và không retry vô hạn.

State được ghi atomic vào `DATA_DIR/state.json`. StateStore snapshot các write chồng lấp, báo lỗi ghi cho caller, vẫn cho phép write tiếp theo và dọn temporary file lỗi.

## Chạy trên Linux

Từ thư mục repository:

~~~bash
npm ci
cp .env.example .env
# chỉnh sửa .env bằng editor an toàn
npm start
~~~

Để chạy lâu dài, dùng process supervisor chung như systemd hoặc service manager khác. Đảm bảo `.env` riêng tư và service account có quyền ghi `DATA_DIR`. LocalAFK không cung cấp systemd unit hoặc deployment script.

## Chạy trên Windows

Trong PowerShell:

~~~powershell
npm ci
Copy-Item .env.example .env
# chỉnh sửa .env
npm start
~~~

Khi chạy unattended, dùng Task Scheduler hoặc Windows service wrapper đáng tin cậy. LocalAFK không cần listening port và không cần desktop session sau khi process đã start.

## Process supervision

LocalAFK xử lý SIGTERM và SIGINT bằng cách dừng VoiceManager, destroy Discord client rồi thoát. Process supervisor của hệ điều hành chịu trách nhiệm restart sau crash hoặc host restart.

Process supervision là tùy chọn khi phát triển local và được khuyến nghị khi chạy unattended. Không thêm hot-reload source vào process production; hãy restart process sau khi đổi code.

## Bảo mật

- Không commit `.env` hoặc làm lộ `BOT_TOKEN`.
- Reset bot token ngay nếu bị lộ.
- Chỉ đưa Discord user ID đáng tin vào `OWNER_DISCORD_IDS`.
- Runtime authorization là authority cuối cùng; role và Discord permission metadata không thay thế owner-ID check.
- Mọi response điều khiển và diagnostics đều là ephemeral.
- Bot chỉ yêu cầu `Guilds` và `GuildVoiceStates`; không yêu cầu Message Content Intent.
- Chỉ cấp Discord permission cần thiết cho guild và voice channel.
- LocalAFK điều khiển bot account, không được dùng để tự động hóa personal Discord account.

## Kiểm thử

Chạy bộ test Node.js tích hợp:

~~~bash
npm test
~~~

Test bao phủ:

- authorization, owner dispatch, safe error và ephemeral reply;
- voice join, leave, reconnect, status, invalid channel và command error;
- guild/global command registration;
- command-schema comparison ổn định và startup no-op;
- VoiceManager generation lifecycle và reconnect regression;
- StateStore atomic persistence, overlapping snapshot, queue recovery, malformed JSON và cleanup temporary file;
- authorization của `/afk stats` (owner/guild/cooldown), redaction (không remote IP, không argv/env), graceful degradation khi thiếu `ss`/`ps` hoặc không phải Linux, và truncation theo response-size.

Các kiểm tra bổ sung:

~~~bash
npm ci
npm audit --omit=dev
npm ls --depth=0
~~~

GitHub Actions chạy `npm ci` và `npm test` trên Node 24 cho push và pull request vào `master`.

## Cấu trúc dự án

~~~text
src/
  config.js                   Minimal environment contract
  index.js                    Startup, command sync, restore và shutdown
  discord/
    client.js                 Discord client và minimal intents
    commandManager.js         Slash command, authorization, sync, diagnostics
    silenceStream.js          Silent Opus frame stream
    voiceManager.js           Persistent voice lifecycle
  store/stateStore.js         Atomic JSON persistence
  system/statsProvider.js     Thống kê host/VPS read-only (CPU, RAM, disk, port, process)
test/
  commandManager.test.js
  stateStore.test.js
  statsProvider.test.js
  voiceManager.test.js
audit/                         Historical review và completion reports
~~~

## Xử lý sự cố

### Không thấy command

Kiểm tra bot đã được invite với scope `applications.commands` và `BOT_TOKEN` hợp lệ. Đặt `COMMAND_GUILD_ID` thành test guild để đăng ký nhanh, restart process hoặc chạy `/afk commands sync`.

Global command có thể propagate lâu hơn guild command.

### Tôi bị từ chối unauthorized

Copy Discord user ID của bạn và thêm vào `OWNER_DISCORD_IDS` dạng phân tách bằng dấu phẩy. Restart process sau khi đổi `.env`.

### Bot không join được voice

Kiểm tra channel được chọn là voice hoặc stage channel và bot có quyền Connect, Speak. Command phải được chạy trong target guild.

### Voice target lưu bị invalid sau restart

Kiểm tra guild/channel còn tồn tại, bot vẫn là member của guild và permission còn đủ. Join một channel hợp lệ lần nữa để thay target đã lưu.

### Process thoát khi startup

Kiểm tra console output về `BOT_TOKEN` thiếu, `OWNER_DISCORD_IDS` thiếu, không truy cập được command guild, Discord login error hoặc command registration error.

### Voice reconnect liên tục

Kiểm tra kết nối Discord Gateway, độ ổn định host/network và voice permission. `/afk voice status` và `/afk diagnostics` cho biết state hiện tại mà không cần shell access.

## Giới hạn

- Không có session và web authentication; control chỉ qua Discord slash command.
- Một process sở hữu bot và voice connection. Chưa có multi-process coordination.
- desiredVoice được giữ lại khi guild/channel không còn hợp lệ; không tự xóa âm thầm.
- Global command propagation phụ thuộc Discord và có thể chậm hơn guild registration.
- Voice presence liên tục vẫn phụ thuộc Discord, network, host, process supervision và permission.
- Auth/API/frontend test của dashboard cũ không còn vì runtime đó đã bị loại bỏ; command, voice và persistence được bao phủ bởi test tích hợp hiện tại.

## Releases

Bản stable mới nhất là [v1.0.0](https://github.com/thuanlyt/LocalAFK/releases/tag/v1.0.0).

Release tag được xem là snapshot bất biến. Branch `master` có thể chứa thay đổi tài liệu hoặc phát triển sau release mới nhất.

## Đóng góp

Hoan nghênh issue và pull request.

Trước khi mở pull request:

- giữ runtime nhỏ và direct dependency tối thiểu;
- chạy `npm ci`, `npm test` và `npm audit --omit=dev`;
- thêm test cho authorization, command sync, voice lifecycle hoặc persistence khi thay đổi liên quan;
- không thêm web, Docker, database hoặc hot-reload infrastructure nếu chưa có feature agreement riêng;
- không đưa token, `.env`, local state hoặc deployment credential vào commit.

## Giấy phép

LocalAFK được phát hành theo [MIT License](LICENSE).

## 💖 Ủng hộ dự án

LocalAFK là một dự án **miễn phí và mã nguồn mở**. Nếu dự án giúp ích cho bạn, hãy tặng một ⭐ **Star** — đó là động lực để chúng tôi tiếp tục duy trì và cải thiện dự án.

<a href="https://github.com/thuanlyt/LocalAFK/stargazers">
  <img src="https://img.shields.io/github/stars/thuanlyt/LocalAFK?style=social" alt="GitHub Stars">
</a>

### 🤝 Cộng đồng & Hỗ trợ

- 📖 [Đọc tài liệu](https://github.com/thuanlyt/LocalAFK#readme)
- 🐛 [Báo lỗi](https://github.com/thuanlyt/LocalAFK/issues)
- 🌐 [Website ThuanLYT](https://thuanlyt.id.vn)

<p align="center"><em>Built with ❤️ by ThuanLYT</em></p>
