# LocalAFK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E22.12-brightgreen.svg)](package.json)
[![CI](https://github.com/thuanlyt/LocalAFK/actions/workflows/ci.yml/badge.svg)](https://github.com/thuanlyt/LocalAFK/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/thuanlyt/LocalAFK)](https://github.com/thuanlyt/LocalAFK/releases/latest)

[English](./README.md) | **Tiếng Việt**

LocalAFK là một Discord bot headless, nhẹ, được điều khiển hoàn toàn bằng slash command. Bot quản lý tối đa **5 tài khoản Discord bot chính thức** (1 Controller + tối đa 4 Worker) cùng giữ kết nối voice channel, tự khôi phục từng voice target đã lưu sau khi restart, và hiển thị diagnostics cùng thống kê VPS/host trực tiếp trong Discord — tất cả chỉ từ **một** process Node.js duy nhất.

Dự án không có dashboard, HTTP server, browser control plane, web login, yêu cầu Docker, database hay reverse proxy.

**Bản ổn định hiện tại:** [v1.2.0](https://github.com/thuanlyt/LocalAFK/releases/tag/v1.2.0)

## Nội dung

- [LocalAFK là gì](#localafk-là-gì)
- [Vì sao headless](#vì-sao-headless)
- [Tính năng](#tính-năng)
- [Kiến trúc](#kiến-trúc)
- [Kiến trúc 5 bot](#kiến-trúc-5-bot)
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

- BotManager quản lý tối đa 5 Discord Client (1 Controller + 4 Worker), mỗi bot có VoiceManager riêng và voice target lưu riêng;
- CommandManager (chỉ gắn vào Controller) để đăng ký slash command, kiểm tra quyền, dispatch và diagnostics;
- StatsProvider để lấy thống kê VPS/host read-only;
- StateStore JSON nhỏ, ghi atomic, riêng cho từng bot slot (voice target mong muốn, và với Worker là trạng thái enabled/stopped).

Discord là giao diện và control plane của bot. Chỉ việc dừng process Node.js mới dừng toàn bộ runtime connection của cả 5 bot.

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

- Một root slash command: /afk, chỉ Controller (Bot 1) đăng ký.
- Tối đa 5 tài khoản Discord bot chính thức (1 Controller + 4 Worker) quản lý từ một process.
- Allowlist owner qua OWNER_DISCORD_IDS, phân tách bằng dấu phẩy, cộng thêm guild gate kiểm tra lúc thực thi khi cấu hình COMMAND_GUILD_ID.
- Response ephemeral cho control, status, sync, diagnostics và lỗi.
- Đăng ký command theo guild để thử nghiệm nhanh hoặc global cho nhiều guild.
- Startup command sync chỉ ghi lên Discord khi schema thực sự khác.
- Join, leave, reconnect, status và liệt kê thành viên voice — theo từng bot, chọn qua option `bot:` (mặc định Bot 1).
- Điều khiển vòng đời Worker ngay từ Discord: `/afk bot list|start|stop|restart` — không cần SSH.
- Silent Opus frames để duy trì voice connection của từng bot.
- Voice lifecycle có generation guard và reconnect backoff giới hạn, độc lập theo từng bot.
- Ghi desiredVoice atomic cho từng bot, và trạng thái enabled/stopped cho từng Worker, có khả năng phục hồi sau lỗi ghi.
- `/afk status`: CPU/RAM/heap/uptime của chính process LocalAFK, cộng trạng thái sống của cả 5 bot slot.
- Thống kê VPS/host read-only (`/afk stats`): CPU, RAM, swap, disk, listening port (kèm PID/process sở hữu) và top process — không cần SSH.
- Đọc file môi trường bằng Node.js native, không cần dependency runtime ngoài Node.js và npm.

## Kiến trúc

~~~text
                  systemd (hoặc process supervisor khác)
                                │
                        localafk.service
                                │
                  1 process Node.js, 1 CommandManager
                                │
                           BotManager
      ┌───────────┬───────────┬───────────┬───────────┬───────────┐
      ▼           ▼           ▼           ▼           ▼
   Bot 1        Bot 2       Bot 3       Bot 4       Bot 5
Controller      Worker      Worker      Worker      Worker
Client +        Client +    Client +    Client +    Client +
VoiceManager    VoiceManager VoiceManager VoiceManager VoiceManager
      │           │           │           │           │
state.json  state.bot2.json ... state.bot5.json (độc lập, atomic)
~~~

Mỗi bot chỉ yêu cầu hai intent `Guilds` và `GuildVoiceStates`. Không bot nào subscribe message content hoặc message events. Cả 5 Client cùng sống trong một Node/V8 runtime — thiết kế cố ý để tốn RAM ít nhất; xem [Kiến trúc 5 bot](#kiến-trúc-5-bot).

## Kiến trúc 5 bot

LocalAFK quản lý tối đa 5 tài khoản Discord bot chính thức từ một process Node.js, một systemd service, một BotManager duy nhất — không phải 5 process, không Worker Threads, không container Docker.

- **Bot 1 (Controller, `BOT_TOKEN`)** bắt buộc. Bot này sở hữu việc đăng ký slash command, `/afk status`, `/afk stats`, và authorization cho mọi command (kể cả điều khiển 4 Worker). Nếu Controller login thất bại, startup fatal và process thoát với mã khác 0 — OS supervisor chịu trách nhiệm restart.
- **Bot 2-5 (Worker, `TOKEN_2`..`TOKEN_5`)** tùy chọn. Mỗi Worker là một tài khoản bot chính thức riêng, Discord Client riêng, VoiceManager riêng với voice target lưu riêng — không bao giờ dùng chung với slot khác. Worker **không** đăng ký slash command và không có interaction handler riêng; chỉ điều khiển được qua slash command của Controller.
- Để trống token của một slot worker khiến slot đó `UNCONFIGURED` — Controller vẫn chạy bình thường dù 0, một vài, hay cả 4 Worker được cấu hình.
- Lỗi login của một Worker chỉ giới hạn ở slot đó (`FAILED`, kèm lỗi đã làm sạch) và không ảnh hưởng Controller hay Worker khác.
- **Stop một Worker sẽ giải phóng runtime**: gọi `client.destroy()` và `VoiceManager.shutdown()`, xóa reference Client/VoiceManager, chỉ giữ lại state nhỏ (voice target đã lưu + `enabled: false`). Worker đã stop không còn Gateway connection, không voice connection, không listener thừa. **Stop Worker không giống rời voice** — target đã lưu vẫn được giữ để `/afk bot start` kết nối lại đúng chỗ cũ.
- Cờ `enabled` của mỗi Worker được lưu (`DATA_DIR/state.bot<N>.json`) và tồn tại qua restart process hay reboot VPS: Worker đã stop sẽ vẫn stop; Controller luôn khởi động.
- Lúc startup, các Worker đã cấu hình và enabled được start tuần tự với khoảng nghỉ ngắn có giới hạn (không phải burst đồng loạt, không có timer/polling loop thường trực) sau khi Controller sẵn sàng và voice target của nó đã khôi phục.
- **Token trùng lặp bị từ chối lúc startup**: nếu hai slot dùng chung một token, LocalAFK fail an toàn với thông báo kiểu `Duplicate bot token configured for slots 1 and 3` — không bao giờ log giá trị token.

### Yêu cầu invite cho từng bot

- **Controller**: invite với scope `bot` và `applications.commands` (cần để đăng ký `/afk`), cộng quyền Connect/Speak ở voice channel cần quản lý.
- **Worker**: invite với scope `bot` và quyền Connect/Speak — **không cần scope `applications.commands` hay đăng ký slash command LocalAFK nào** — Worker không bao giờ là mục tiêu của lệnh đăng ký slash command.

### Báo cáo tài nguyên theo từng bot — giới hạn có chủ đích

Cả 5 Client chạy chung trong **một** process Node/V8. Linux không thể quy chính xác một phần CPU/RSS của process cho riêng một Client trong số nhiều Client dùng chung event loop và heap, và LocalAFK không bịa ra con số đó: `/afk status` báo cáo **tổng CPU/RSS/heap của cả process**, chính xác, một lần, và trạng thái **vận hành theo từng bot** (online/stopped/failed, uptime, ping, voice state) cho từng slot trong 5 slot — không bao giờ chia tổng process cho 5 hay bịa số riêng từng bot. Đây là đánh đổi có chủ đích để đạt RAM thấp nhất; muốn có CPU/RAM đáng tin cậy theo từng bot sẽ cần process OS riêng (hoặc Worker Threads với overhead riêng) cho mỗi bot, đi ngược lại mục tiêu "nhẹ nhất có thể" của kiến trúc này.

## Yêu cầu

- Node.js >=22.12.0; khuyến nghị Node.js 24 LTS.
- npm tương thích với Node.js đang cài.
- Một Discord application + bot token cho Controller (Bot 1), và thêm một application/token cho mỗi Worker muốn cấu hình (Bot 2-5).
- Controller được invite với scope `bot` và `applications.commands`; mỗi Worker chỉ cần scope `bot`.
- Quyền truy cập guild và voice channel cần quản lý.
- Quyền Connect và Speak trong (các) voice channel mục tiêu.

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

Để pin checkout vào bản stable hiện tại thay vì branch master:

~~~bash
git checkout v1.2.0
~~~

Invite bot Controller với scope `bot` và `applications.commands`, sau đó chạy `/afk ping` trong guild nơi Discord user ID của bạn đã có trong `OWNER_DISCORD_IDS`. Cấu hình `TOKEN_2`..`TOKEN_5` (mỗi cái là một bot riêng, chỉ cần scope `bot`) bất cứ lúc nào sau đó — xem [Kiến trúc 5 bot](#kiến-trúc-5-bot).

Khi phát triển:

~~~bash
npm run dev
~~~

## Cấu hình

| Biến | Bắt buộc | Mô tả |
| --- | --- | --- |
| BOT_TOKEN | Có | Discord bot token của Bot 1 (Controller). Hãy bảo vệ như password. |
| TOKEN_2 | Không | Discord bot token của Bot 2 (Worker). Để trống thì slot đó unconfigured. |
| TOKEN_3 | Không | Discord bot token của Bot 3 (Worker). |
| TOKEN_4 | Không | Discord bot token của Bot 4 (Worker). |
| TOKEN_5 | Không | Discord bot token của Bot 5 (Worker). |
| OWNER_DISCORD_IDS | Có | Danh sách Discord user ID được phép chạy `/afk`, phân tách bằng dấu phẩy. |
| COMMAND_GUILD_ID | Không | Đăng ký command trong một guild này. Để trống nghĩa là global registration. Khi được đặt, `/afk` cũng từ chối mọi interaction đến từ guild khác ngay lúc thực thi, độc lập với scope đăng ký. |
| DATA_DIR | Không | Thư mục chứa các file state. Mặc định là `./data`. Bot 1 dùng `state.json`; mỗi Worker slot N đã cấu hình dùng riêng `state.bot<N>.json`. |
| STATS_SHOW_HOSTNAME | Không | Đặt `true` để hiển thị hostname của OS trong `/afk stats`. Mặc định ẩn, vì hostname tự đặt có thể chứa thông tin định danh/riêng tư. |

Ứng dụng yêu cầu cả `BOT_TOKEN` và ít nhất một owner ID. `TOKEN_2`..`TOKEN_5` độc lập tùy chọn — có thể cấu hình bất kỳ tập con nào (kể cả không cấu hình gì). Hai slot dùng chung một token là lỗi startup (xem [Kiến trúc 5 bot](#kiến-trúc-5-bot)). `COMMAND_GUILD_ID` hữu ích khi phát triển vì guild command cập nhật nhanh hơn; global command có thể cần thời gian propagate.

Chỉ tạo hoặc copy secret trong file `.env` local, giữ file này riêng tư. `.env` đã được Git ignore và tuyệt đối không được commit.

## Slash command

Tất cả `/afk` command chỉ dành cho owner. Quyền được kiểm tra runtime bằng `interaction.user.id`; interaction không được phép nhận response ephemeral và không gây side effect.

| Command | Hành vi |
| --- | --- |
| `/afk voice join channel:<voice channel> bot:<1-5, tùy chọn>` | Validate guild/channel, lưu target và connect hoặc chuyển voice cho bot được chọn (mặc định Bot 1). |
| `/afk voice leave bot:<1-5, tùy chọn>` | Xóa target đã lưu, hủy reconnect và dừng voice cho bot được chọn. |
| `/afk voice reconnect bot:<1-5, tùy chọn>` | Giữ target đã lưu, dispose connection hiện tại và reconnect có chủ đích cho bot được chọn. |
| `/afk voice status bot:<1-5, tùy chọn>` | Hiển thị state connected/reconnecting, target, duration và reconnect state cho bot được chọn. |
| `/afk voice members bot:<1-5, tùy chọn>` | Liệt kê thành viên trong voice channel của bot được chọn, đánh dấu bot và tự cắt nội dung dài. |
| `/afk bot list` | Tổng quan gọn gàng cả 5 slot: online/offline, voice state, hoặc saved target nếu đang stopped. |
| `/afk bot start bot:<2-5>` | Start một Worker: tạo Client + VoiceManager mới, login, khôi phục voice target đã lưu. |
| `/afk bot stop bot:<2-5>` | Stop một Worker: shutdown VoiceManager, destroy Client, giải phóng runtime — voice target đã lưu vẫn được giữ, không xóa. |
| `/afk bot restart bot:<2-5>` | Stop rồi start lại ngay một Worker (runtime hoàn toàn mới), giữ nguyên voice target đã lưu. Bot 1 không thể start/stop/restart theo cách này — nó theo vòng đời của chính process. |
| `/afk commands status` | Hiển thị scope guild/global, local count, remote count và schema sync state. |
| `/afk commands sync` | Buộc đồng bộ schema command và báo scope/count. |
| `/afk ping` | Hiển thị gateway ping và process uptime của Controller. |
| `/afk status` | Hiển thị CPU/RAM/heap/uptime của chính process LocalAFK, cộng trạng thái sống của cả 5 bot slot. |
| `/afk diagnostics` | Hiển thị operational snapshot an toàn cấp Controller, không có token, secret, owner ID hoặc private path. |
| `/afk stats` | Hiển thị thống kê hệ thống VPS/host read-only: CPU, RAM, swap, disk, listening port (kèm PID/process sở hữu) và top process. Không có dữ liệu riêng theo bot — xem `/afk status` cho phần đó. |

Response điều khiển và diagnostics đều là ephemeral. Handler voice gọi public API VoiceManager của đúng bot mục tiêu, không sao chép voice lifecycle logic, và CommandManager không bao giờ dùng chung một VoiceManager cho hai bot.

### /afk status

`/afk status` là trạng thái của chính process LocalAFK và cả 5 bot — **không phải** giám sát toàn VPS (đó là việc của `/afk stats`). Trong một response ephemeral, lệnh báo cáo:

- PID của chính process LocalAFK, CPU% (lấy mẫu trong khoảng ngắn ~150-250ms, chuẩn hóa theo tổng năng lực CPU của VPS — vd. "2.4%" nghĩa là 2.4% của cả VPS, không phải của một core), RSS (và RSS dưới dạng % tổng RAM VPS), heap đang dùng, và uptime;
- có bao nhiêu trong 5 slot đã cấu hình, bao nhiêu bot đang online, và bao nhiêu đang voice-connected;
- trạng thái thật của từng slot trong 5 slot (`UNCONFIGURED` / `STOPPED` / `STARTING` / `ONLINE` / `FAILED`), và với bot đang online: tag, uptime, gateway ping, số guild, voice state/target;
- một dòng nói rõ CPU/RAM theo từng bot không thể quy chính xác trong runtime dùng chung một process — xem [Báo cáo tài nguyên theo từng bot](#báo-cáo-tài-nguyên-theo-từng-bot--giới-hạn-có-chủ-đích). Không bao giờ bỏ hẳn một bot slot để tiết kiệm chỗ; nếu response đầy đủ vượt giới hạn kích thước của Discord, mỗi bot sẽ được rút gọn còn một dòng trước khi bị cắt bớt.

### /afk stats

`/afk stats` cho phép owner quan sát sức khỏe **VPS/host** trực tiếp từ Discord, không cần SSH — thuần túy ở mức host, không có mục riêng theo bot (đó là `/afk status`). Lệnh này:

- **chỉ đọc** — không bao giờ exec shell, không nhận command tùy ý, không thể kill/restart/reboot hay sửa bất kỳ file nào;
- **owner-only và ephemeral** như mọi command `/afk` khác, và bị giới hạn theo guild khi `COMMAND_GUILD_ID` được cấu hình;
- **có rate-limit** — tối đa 1 lần mỗi 5 giây cho mỗi owner, tránh gọi `ps`/`ss` lặp lại không cần thiết;
- **được redact có chủ đích** — không bao giờ hiển thị remote peer IP, không hiển thị argv/environment/cwd của process (bảng process chỉ có pid, CPU%, MEM% và tên executable; bảng port chỉ có protocol/bind/port/state/PID/process), và hostname của OS bị ẩn trừ khi đặt rõ `STATS_SHOW_HOSTNAME=true`.

Lệnh không mở HTTP port, không khởi động monitoring server, không thêm web dashboard — Discord vẫn là control plane duy nhất. Trên Linux, lệnh đọc `/proc`, các hàm built-in của `os`, và hai executable cố định `ps`/`ss` với tham số cố định qua `execFile` (không bao giờ dùng chuỗi shell); trên các nền tảng khác (kể cả Windows), phần port/process báo "Unavailable on this platform" thay vì đoán mò hay crash, trong khi CPU/RAM/disk vẫn khả dụng ở bất cứ đâu `fs.statfs`/`os` hỗ trợ.

**Quy về process cho listening port.** `ss -p` không có quyền root chỉ thấy tên process/PID của socket thuộc cùng user chạy LocalAFK, nên các process như `sshd` hay `nginx` (chạy bằng `root` hoặc user khác) có thể hiện `unknown`. LocalAFK không bao giờ tự chạy bằng root để giải quyết việc này. Thay vào đó, nếu triển khai một helper root có phạm vi hẹp, `/afk stats` sẽ tự dùng nó:

- một script cố định, thuộc sở hữu root, tại `/usr/local/libexec/localafk-portstats`, nhận **0** tham số và chỉ chạy đúng `ss -H -lntup` — không gì khác;
- một entry trong `sudoers.d` cấp cho service account LocalAFK quyền chạy passwordless **đúng path helper đó**, không rộng hơn (không shell, không `ps`, không `systemctl`, không sudo tổng quát);
- gọi bằng `execFile('/path/to/sudo', ['-n', '/usr/local/libexec/localafk-portstats'])` — không chuỗi shell, không interpolation, không tham số nào đến từ Discord hay người dùng.

Nếu helper chưa cài hoặc chưa cấu hình, `/afk stats` tự động và âm thầm fallback về gọi `ss` không có quyền root — một số entry có thể hiện `unknown`, nhưng lệnh không bao giờ crash hay bị treo vì việc này.

### Đăng ký command

Khi startup, LocalAFK build schema `/afk` local, fetch command remote trong scope đã cấu hình, normalize các field liên quan rồi compare. Nếu giống nhau, đăng ký là no-op. Nếu khác, LocalAFK replace command set bằng schema local.

- Có `COMMAND_GUILD_ID`: đăng ký command trong guild đó.
- `COMMAND_GUILD_ID` trống: đăng ký command global.
- `/afk commands sync`: buộc đồng bộ.
- `/afk commands status`: xem kết quả so sánh hiện tại mà không mutate Discord.

Bot không hot-reload source code. Sau khi đổi application, hãy restart process Node.js; chỉ dùng `/afk commands sync` cho việc đăng ký command.

## Lưu trạng thái voice

Mỗi bot đã cấu hình (Controller và từng Worker) có VoiceManager riêng và target lưu riêng — không bao giờ dùng chung giữa các slot.

- `/afk voice join` kiểm tra channel voice/stage trong guild của interaction trước khi lưu, cho đúng bot được chọn.
- Mỗi VoiceManager gửi silent Opus stream ổn định.
- Disconnect bất ngờ sẽ reconnect với backoff giới hạn từ 5 giây đến 60 giây, độc lập theo từng bot.
- Generation guard ngăn event và timer cũ ảnh hưởng connection mới.
- `/afk voice reconnect` giữ desiredVoice và chủ động thay connection hiện tại.
- `/afk voice leave` xóa desiredVoice và không reconnect.
- `/afk bot stop` dừng runtime của Worker nhưng giữ desiredVoice — stop khác với leave.
- Shutdown process (hoặc `/afk bot stop`) dừng runtime connection nhưng giữ desiredVoice cho startup sau.
- Guild/channel đã lưu nhưng không còn hợp lệ sẽ được log và không retry vô hạn.

State được lưu atomic theo từng bot: Bot 1 ở `DATA_DIR/state.json`, mỗi Worker N đã cấu hình ở `DATA_DIR/state.bot<N>.json`. Mỗi StateStore snapshot các write chồng lấp, báo lỗi ghi cho caller, vẫn cho phép write tiếp theo và dọn temporary file lỗi.

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

LocalAFK xử lý SIGTERM và SIGINT bằng cách gọi BotManager.shutdown(): shutdown VoiceManager và destroy Client của từng Worker đang hoạt động, rồi shutdown VoiceManager và destroy Client của Controller. desiredVoice của mọi bot và enabled state của mọi Worker đều được giữ nguyên — restart sẽ đưa Controller lên lại ngay và khôi phục đúng những Worker đã enabled trước đó. Process supervisor của hệ điều hành chịu trách nhiệm restart sau crash hoặc host restart; đây vẫn là một process duy nhất được supervise, bất kể bao nhiêu trong 5 slot đã cấu hình.

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
- authorization của `/afk stats` (owner/guild/cooldown), redaction (không remote IP, không argv/env), fallback helper-có-quyền/`ss`-thường, graceful degradation khi thiếu `ss`/`ps` hoặc không phải Linux, và truncation theo response-size;
- config: bắt buộc BOT_TOKEN/OWNER_DISCORD_IDS, tùy chọn TOKEN_2..TOKEN_5, phát hiện token trùng lặp mà không lộ giá trị token;
- BotManager: vòng đời Controller vs Worker, start/stop/restart, enabled state được giữ qua mô phỏng restart, cô lập lỗi login của worker, giải phóng runtime khi stop, và state file tách biệt theo từng slot;
- CommandManager multi-bot dispatch: `/afk bot list/start/stop/restart`, bot selector của lệnh voice (kể cả hành vi mặc định Bot 1 và từ chối target unconfigured/stopped/failed), và `/afk status` (tổng process, cả 5 slot, và không bao giờ bịa CPU/RAM riêng từng bot);
- lấy mẫu CPU chuẩn hóa cho process (theo tổng số core, không phải theo từng core, và không bao giờ nhầm cumulative time thành %).

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
  config.js                   Environment contract: token (1 Controller + 4 Worker), owner ID, guild scope
  index.js                    Thứ tự startup, command sync, restore và shutdown
  discord/
    client.js                 Discord client factory và minimal intents (dùng chung cho cả 5 slot)
    botManager.js              Quản lý cả 5 bot slot: lifecycle, cô lập lỗi, state riêng từng slot
    commandManager.js         Slash command, authorization, dispatch, /afk status, /afk stats
    silenceStream.js          Silent Opus frame stream
    voiceManager.js           Persistent voice lifecycle (mỗi bot đã cấu hình một instance)
  store/stateStore.js         Atomic JSON persistence (mỗi bot slot một file)
  system/
    statsProvider.js          Thống kê host/VPS read-only (CPU, RAM, disk, port, process)
    processStats.js           Lấy mẫu CPU chuẩn hóa cho process LocalAFK, dùng cho /afk status
test/
  botManager.test.js
  commandManager.test.js
  config.test.js
  processStats.test.js
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

Kiểm tra console output về `BOT_TOKEN` thiếu, `OWNER_DISCORD_IDS` thiếu, token trùng lặp giữa hai slot (`Duplicate bot token configured for slots X and Y`), không truy cập được command guild, Discord login error hoặc command registration error. Chỉ lỗi login của Controller mới fatal; lỗi login của Worker chỉ giới hạn ở slot đó (xem [Kiến trúc 5 bot](#kiến-trúc-5-bot)).

### Một Worker hiện FAILED hoặc STOPPED trong /afk bot list

FAILED nghĩa là lần login đó bị lỗi (token sai, hoặc application đó không có bot user) — xem `/afk bot list` để biết lý do đã làm sạch, sửa `.env` rồi chạy `/afk bot restart bot:<N>`. STOPPED nghĩa là owner (hoặc bạn) trước đó đã chạy `/afk bot stop` — voice target đã lưu vẫn còn; chạy `/afk bot start bot:<N>` để bật lại.

### Voice reconnect liên tục

Kiểm tra kết nối Discord Gateway, độ ổn định host/network và voice permission. `/afk voice status`, `/afk bot list` và `/afk diagnostics` cho biết state hiện tại mà không cần shell access.

## Giới hạn

- Không có session và web authentication; control chỉ qua Discord slash command.
- Một process Node.js sở hữu cả 5 bot slot và voice connection của chúng. Không có Worker Threads, multi-process hay cô lập bằng container giữa các bot — xem [Báo cáo tài nguyên theo từng bot](#báo-cáo-tài-nguyên-theo-từng-bot--giới-hạn-có-chủ-đích) để biết lý do và đánh đổi mang lại.
- CPU/RAM theo từng bot không thể quy chính xác; `/afk status` báo cáo tổng process chính xác và trạng thái vận hành từng bot chính xác (online/voice/ping/...), không bao giờ bịa ra một con số CPU/RAM riêng cho từng bot.
- desiredVoice được giữ lại khi guild/channel không còn hợp lệ; không tự xóa âm thầm.
- Global command propagation phụ thuộc Discord và có thể chậm hơn guild registration.
- Voice presence liên tục vẫn phụ thuộc Discord, network, host, process supervision và permission — độc lập theo từng bot.
- Việc quy process cho listening port trong `/afk stats` có thể hiện `unknown` với socket thuộc user khác, trừ khi triển khai helper root phạm vi hẹp tùy chọn (xem [/afk stats](#afk-stats)).
- Auth/API/frontend test của dashboard cũ không còn vì runtime đó đã bị loại bỏ; command, voice, vòng đời multi-bot và persistence được bao phủ bởi test tích hợp hiện tại.

## Releases

Bản stable mới nhất là [v1.2.0](https://github.com/thuanlyt/LocalAFK/releases/tag/v1.2.0).

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
