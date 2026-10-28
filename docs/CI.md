# 代码质量 CI

`.github/workflows/quality.yml` 在所有分支的 Push、Pull Request 和手动触发时运行，不包含部署、镜像推送或生产凭据。

## 配置与必要修复

- 新增 `.github/workflows/quality.yml`、`sonar-project.properties` 和本文档，README 增加入口。
- `backend/pyproject.toml` 增加 pytest-cov 与覆盖率配置，并固定已验证 Ruff 版本；按授权对后端进行全量 Ruff 格式修复。
- `frontend/package.json`、`pnpm-lock.yaml` 与新增 `eslint.config.js` 集成 ESLint，拆分类型检查并增加 CI 测试命令。
- 前端图片恢复测试适配当前 Context/hover 导入及真实组件行为；仅做未用导入、失效注释和 const 的必要 lint 清理。
- `.gitignore` 排除覆盖率、JUnit、安全报告及扫描缓存，避免提交验证产物。
- 保留本次开始前已有的业务改动，没有提交或推送。

## 检查范围

| 检查 | 实际命令 / 行为 |
| --- | --- |
| Python lint | `python -m ruff check app tests`，沿用 E、F、I、UP 规则 |
| Python 格式 | `python -m ruff format --check app tests` |
| 后端测试 | Python 3.12，pytest + pytest-asyncio + pytest-cov，包含 backend/tests 与 scripts 的 Python 回归测试，生成 JUnit 和分支覆盖率 XML |
| 前端 lint | `pnpm lint`，ESLint + TypeScript + React Hooks 经典规则 |
| TypeScript | `pnpm typecheck`，原来的 `tsc -b --pretty false` |
| 前端格式 | `pnpm format:check`，复用原有 Prettier 配置 |
| 前端测试 | `pnpm test:ci`，复用 Node 内置测试，输出控制台和 JUnit |
| 前端构建 | `pnpm build`，TypeScript + Vite 生产构建，仅上传产物 |
| 安全扫描 | Trivy 扫描 Python 精确解析依赖、pnpm 锁文件、secret 和配置；HIGH/CRITICAL 阻断 |
| SonarQube | 可选；等待服务器 Quality Gate，未通过则失败 |

后端没有现有 mypy/pyright 配置，本次不强行引入另一套类型门禁。TypeScript 严格模式继续由已有 tsconfig 控制。

后端测试运行于 Windows hosted runner，提供 ImageMagick 7 的 `magick` 命令以及 FFmpeg/FFprobe，软件编码使用 `libx264`，不需要 GPU。缺少媒体工具时通过 runner 自带的 Chocolatey 安装。其余作业运行于 Ubuntu 24.04。前端 Node.js 22，pnpm 版本直接读取 `frontend/package.json` 的 `packageManager`，依赖按 `pnpm-lock.yaml` 冻结安装。

后端同时保留现有 `[dependency-groups].dev` 和 `[project.optional-dependencies].dev`，覆盖 uv 与 pip 使用方式。CI 用 `pip install -e './backend[dev]'`。Ruff 固定到本次验证版本，避免未来格式规则变化导致全库突然失败。后端当前没有锁文件，其他 Python 依赖按已有版本范围解析；安全作业在独立虚拟环境安装同一组依赖，导出包含传递依赖的精确 `requirements.txt` 后扫描。

## 无需配置的部分

Ruff、pytest、前端检查/测试/构建、Trivy 均不需要自定义 CI secrets。测试使用临时文件、SQLite 和模拟 HTTP，不需要生产数据库、TMDB 或 qBittorrent 账号。

工作流仅授予 `contents: read`；通过普通 `pull_request` 事件运行，不使用 `pull_request_target`。Actions 按官方提交 SHA 固定。报告和前端构建产物保留 14 天；测试或扫描失败时仍尝试上传已有报告。

## 配置 SonarQube

先在 SonarQube 创建项目，并在仓库 **Settings → Secrets and variables → Actions** 设置：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Secret | `SONAR_TOKEN` | 有该项目 Execute Analysis 权限的 token |
| Variable | `SONAR_HOST_URL` | GitHub runner 可以访问的 SonarQube HTTPS 地址 |
| Variable | `SONAR_PROJECT_KEY` | SonarQube 中的实际项目 key |
| Variable | `SONAR_ENABLED` | `true` 开启默认分支 Push / 默认分支手动分析；其他值跳过 |
| Variable | `SONAR_PR_ANALYSIS_ENABLED` | 可选，`true` 额外开启同仓 PR 分析；默认关闭 |

默认关闭 PR 分析以兼容只分析主分支的社区版。开启 PR 分析前，确认 SonarQube 版本/许可支持分支及 PR 分析（SonarQube Server 通常需要 Developer Edition 或更高版本），并完成 GitHub 集成以展示 PR 装饰。fork PR 和 Dependabot PR 不读取 Sonar token。启用服务但缺少 token、URL 或 project key 时，作业明确失败。

服务器地址不能是 hosted runner 无法连接的 `localhost` 或私有局域网地址。使用自签名证书的内部服务时，需要按 SonarSource 指引提供可信 CA 或改用可访问该服务的 runner；当前工作流不关闭 TLS 校验。

扫描范围为 `backend/app` 和 `frontend/src`，测试单独标识。后端 XML 路径由仓库根目录下的 coverage 配置生成，供 Linux 上的扫描器消费。前端现有测试通过 VM + TypeScript `transpileModule` 加载源码，没有可靠的源码映射 LCOV；本次不伪造前端覆盖率，`sonar.coverage.exclusions=frontend/**` 明确排除前端覆盖率统计，前端静态分析仍运行。将来引入真实 TS 覆盖率后，应移除此排除并配置 `sonar.javascript.lcov.reportPaths`。

扫描通过 `sonar.qualitygate.wait=true` 等待门禁，服务器处理超时为 300 秒。没有连接实际 SonarQube 服务前，本地验证不代表服务器门禁已经通过。

## 安全扫描与分支保护

Trivy 不忽略未修复漏洞，包含前端开发依赖。Python 报告的 `requirements.txt` 记录本次安装实际选中的版本，便于复现。扫描数据库下载失败也会导致作业失败。报告在 Actions 的 `security-reports` artifact 中。

安全作业排除 `.git`、本地 `.env`、缓存、业务数据、虚拟环境和 node_modules，依赖通过锁文件及精确清单扫描；保留 `.env.example` 和受版本控制的源码扫描。此流程不构建/扫描容器镜像，也不推送镜像。

建议在第一次 GitHub Actions 完整执行后，将 **Quality gate** 作业设置为分支保护必需状态。该汇总检查要求 Python、后端测试、前端、安全作业成功；按配置跳过的 SonarQube 可接受，已运行但失败的 SonarQube 会阻断。这里仅记录建议，不自动修改仓库保护规则。

## 本地验证（PowerShell，从仓库根目录）

```powershell
& .\backend\.venv\Scripts\python.exe -m pip install -e '.\backend[dev]'
Push-Location .\backend
& .\.venv\Scripts\python.exe -m ruff check app tests
& .\.venv\Scripts\python.exe -m ruff format --check app tests
Pop-Location
& .\backend\.venv\Scripts\python.exe -m pytest backend\tests scripts --cov --cov-config=backend\pyproject.toml --cov-report=term-missing --cov-report=xml:backend/coverage.xml --junitxml=backend/reports/pytest.xml
pnpm --dir .\frontend install --frozen-lockfile
pnpm --dir .\frontend lint
pnpm --dir .\frontend typecheck
pnpm --dir .\frontend format:check
New-Item -ItemType Directory -Force .\frontend\reports | Out-Null
pnpm --dir .\frontend test:ci
pnpm --dir .\frontend build
```

Ruff 自动修复和格式化不在 CI 中执行；需要修复格式时在本地运行 `ruff check --fix app tests` 和 `ruff format app tests` 后提交。React Hooks 依赖警告保留在日志中，不为集成 CI 盲目改变播放器等组件的生命周期；ESLint 的 error 仍阻断。

官方参考：[SonarQube GitHub Actions](https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/ci-integration/github-actions)、[Python 覆盖率](https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/test-coverage/python-test-coverage)、[Trivy Node.js](https://www.trivy.dev/docs/latest/guide/coverage/language/nodejs/)、[Trivy Python](https://www.trivy.dev/docs/latest/guide/coverage/language/python/)、[pnpm setup action](https://github.com/pnpm/action-setup)。

## 本次集成验证（2026-10-27）

- Ruff lint 与格式检查通过；按授权自动格式化 80 个后端文件，另做导入顺序和等价长字符串拆分。
- 后端完整测试：653 通过、2 跳过；脚本回归：17 通过。真实 XML 的源码目录为 `backend/app`，52 个源码条目均可按相对路径解析；语句覆盖率 79.74%，分支覆盖率 66.25%，综合显示约 77%。本次未擅自指定全库覆盖率硬阈值，由 SonarQube 的实际 Quality Gate 控制。
- 前端：ESLint 0 错误、15 条 Hooks 依赖警告；类型检查、Prettier、142 项测试、Vite 构建通过，JUnit 报告已生成。现有大 chunk 构建警告保留。
- actionlint 1.7.12 验证最终工作流通过，前端冻结锁文件安装通过，现有后端 `pip check` 通过。
- Trivy 配置/secret 实扫发现既有 `frontend/Dockerfile` 的 HIGH 级 DS-0002：最终 nginx 镜像未声明非 root 用户；未发现 HIGH/CRITICAL secret。该问题未被忽略，当前会使严格安全门禁失败。修复需要同时验证 nginx 的端口、缓存和目录权限，本次没有修改未经容器验证的运行方式。
- 尚未推送或运行 GitHub hosted CI，也未连接实际 SonarQube，因此不把本地验证称为远端 CI / Sonar 门禁已通过。
- 首次 Trivy 完整依赖漏洞扫描因官方数据库下载超时未完成；后续使用本机代理重试成功，完整结果见下方“Trivy 代理重试结果”。CI 扫描超时为 10 分钟，发现问题仍阻断。

- 全新应用/测试环境按现有版本范围重新解析安装后，合并运行 backend/tests 与 scripts：670 通过、2 跳过（197.30 秒），依赖完整性检查通过。最终 XML 语句覆盖率 80.15%，分支覆盖率 66.48%，52 个源码路径均已核对。新环境的 Ruff 大文件下载被网络阻滞，因此 Ruff 使用原环境中同版本 0.16.5 单独验证；不将这一结果称为完整的冷安装成功。


## Trivy 代理重试结果

完整扫描已于 2026-10-27 23:03:40（北京时间）完成。使用本机代理 `http://127.0.0.1:7890` 下载官方漏洞数据库并核对 SHA-256 后，执行 Trivy 0.76.1 文件系统扫描。

扫描返回码为 **1**，原因是发现安全问题；本次完整漏洞扫描没有下载超时或解析失败。

### 结果

| 类别 | HIGH | CRITICAL |
| --- | ---: | ---: |
| 依赖漏洞记录 | 5 | 0 |
| 配置问题 | 1 | 0 |
| 密钥泄露 | 0 | 0 |

以下为 Trivy 数据库给出的结果和修复版本；这些升级尚未执行兼容性验证。

严重程度按本次 Trivy 数据库评级统计。cryptography 维护者原始公告的评级分别为 Moderate、Low、Moderate，与工具使用的全局数据库评级有区别：[公告一](https://github.com/pyca/cryptography/security/advisories/GHSA-g6cj-pr64-35w5)、[公告二](https://github.com/pyca/cryptography/security/advisories/GHSA-jwv3-5hgf-82ww)、[公告三](https://github.com/pyca/cryptography/security/advisories/GHSA-537c-gmf6-5ccf)。

前端两项命中均属于开发依赖，仍按现有“包含开发依赖”的门禁配置执行。

| 包 | 当前版本 | 漏洞编号 | 数据库列出的修复版本 |
| --- | --- | --- | --- |
| `source-map-js` | `1.2.1` | [CVE-2026-93749](https://avd.aquasec.com/nvd/cve-2026-93749) | `1.2.2` |
| `vite` | `6.4.3` | [CVE-2026-112942](https://avd.aquasec.com/nvd/cve-2026-112942) | `8.3.3, 8.2.4, 8.1.6, 7.3.7, 6.4.4` |
| `cryptography` | `46.0.7` | [CVE-2026-69247](https://avd.aquasec.com/nvd/cve-2026-69247) | `50.0.0` |
| `cryptography` | `46.0.7` | [CVE-2026-69249](https://avd.aquasec.com/nvd/cve-2026-69249) | `49.0.0` |
| `cryptography` | `46.0.7` | [GHSA-537c-gmf6-5ccf](https://github.com/advisories/GHSA-537c-gmf6-5ccf) | `48.0.1` |

配置问题为 `frontend/Dockerfile` 的 **DS-0002 / HIGH**：最终 nginx 镜像没有声明非 root 用户。

现有严格安全门禁会因上述问题失败。后端当前声明 `cryptography>=43,<47`，不包含数据库列出的修复版本；需要调整版本范围并验证兼容性。前端数据库列出了 Vite 6.4.4 和 source-map-js 1.2.2，后续修复应更新锁文件并重新测试。

### 扫描范围与来源

- 从现有源码快照刷新了工作流、忽略规则、CI 文档及受版本控制的前端环境模板；排除了生成的 egg-info、真实环境文件、业务数据与缓存。
- 扫描前后端完整的解析依赖，包含开发依赖：
  - `frontend/pnpm-lock.yaml`：344 个包。
  - `python-environment/requirements.txt`：44 个包。
- Python 清单来自本次 Windows 全新应用/测试环境，并补入已验证的 Ruff 0.16.5；GitHub 上的 Linux 作业会导出它实际解析的依赖，因此可能有平台依赖差异。
- 使用 `vuln,secret,misconfig`，筛选 `HIGH,CRITICAL`，包含开发依赖，没有忽略未修复漏洞。
- 官方数据库镜像：`mirror.gcr.io/aquasec/trivy-db:2`；压缩包 136,322,871 字节。
- 数据库更新时间：2026-10-27 21:12:49（北京时间）。
- SHA-256：`90b53abc13dfd9bd8ecb9d8efb9bd7e865833d1ce426afdb2d7b2696b92e95c5`，与官方 OCI manifest 一致。
- 扫描日志中缺少 site-packages/node_modules 的提示只影响许可证信息收集；pip 与 pnpm 漏洞检查均已执行并产出结果。
- 本次完成的是本地完整扫描；GitHub hosted CI 和 SonarQube 服务器门禁仍需在相应服务中执行。

## CI 失败修复（2026-10-28）

[首次 hosted CI](https://github.com/rinhon/Mooncell/actions/runs/40693220979) 的后端结果为 689 通过、1 失败，唯一失败项为 `test_actual_owned_process_suspend_resume_and_stop`。FFmpeg 暂停后，Python 后台线程仍可能消费 stdout 管道中积压的进度，因此固定等待 0.2 秒再断言进度不变会产生竞态。测试现改为有界等待启动和恢复进度，暂停阶段连续核验操作系统的挂起状态及 CPU 时间不变，保留暂停后停止进程的验证。

安全修复包括 Vite 升级到 6.4.5、传递依赖 `source-map-js` 升级到 1.2.2，以及将后端 `cryptography` 的版本范围调整为 `>=50,<51`。前端 nginx 以 `nginx` 用户运行，PID 移到 `/tmp`，缓存目录授予该用户写权限；仅赋予 nginx 可执行文件绑定低端口的能力，继续使用原有 80 端口、反向代理和健康检查。

Trivy 仍包含开发依赖，HIGH/CRITICAL 仍阻断。扫描失败时，新增步骤将 JSON 报告转换为表格输出到作业日志，原始报告继续上传。

本地验证结果：

- 暂停／恢复测试连续运行 10 次通过；Ruff lint、格式检查以及 actionlint 1.7.12 工作流检查通过。
- 使用 cryptography 50.0.2 的独立环境运行完整后端与脚本测试：688 通过、2 跳过、0 失败，耗时 1040.83 秒。两项跳过均因本机 Windows 未允许创建符号链接。JUnit 与覆盖率 XML 已核对；语句覆盖率 80.04%，分支覆盖率 66.32%。升级前后的 Fernet 加密数据可双向解密。
- 前端冻结安装、ESLint、TypeScript、Prettier、149 项测试及 Vite 生产构建通过；保留既有 Hooks 依赖警告和大 chunk 提示。
- Trivy 0.76.1 使用经官方 OCI 摘要校验的漏洞数据库及最新官方检查规则完成实扫，返回码 0；344 个 pnpm 包、44 个 Python 包和 3 个 Dockerfile 中，HIGH/CRITICAL 漏洞、配置问题、密钥问题均为 0。数据库更新时间为北京时间 2026-10-28 15:10:42；没有回退到内置检查规则。最终 JSON 到日志表格的转换也已实际验证。
- nginx 运行阶段使用实际 Dockerfile 与已通过构建的前端产物验证：UID 101，仅持有绑定低端口能力；强制低端口阈值为 1024 时仍可监听 80，PID、缓存权限、`nginx -t`、健康检查及 SPA 深层路径回退均通过。
- 新增 `frontend/.dockerignore` 排除本机 node_modules、产物和真实环境文件。完整 Linux 多阶段冷构建两次受依赖下载超时阻断，直连和本次构建的代理参数重试分别未能下载完 hls.js / Linux esbuild；不将运行阶段验证表述为完整镜像构建成功。

以上为本地验证，不能代替 GitHub hosted CI；远端结果需在推送后确认。
