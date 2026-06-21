修改完项目后，要把项目跑起来给用户看。

不要因为代码改动而自动修改 README.md；只有我明确要求修改 README.md 时再改。

push 到 main 不会再自动触发构建/发布（官网部署 deploy-pages.yml 和安装包发布 release.yml 已改为手动触发，release 仅保留 v*.*.* tag 触发）。每次要 push 时，先问我这次要不要触发构建：
- 要：push 完用 `gh workflow run <workflow>`（如 `deploy-pages.yml` / `release.yml`）手动触发对应构建。
- 不要：只 push 代码，不触发任何构建。
