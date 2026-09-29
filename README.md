# 档案元数据核对台

`sologsb-1020` 是一个用于口述史与手稿档案元数据比对的本地优先前端工作台，使用 Qwik、TypeScript 和 Qwik UI 构建。

## 功能

- 导入 A / B 两组记录，支持 JSON 数组、制表符和竖线分隔文本。
- 按标题、日期、人物、地点和编号加权匹配，显示综合分数与判断依据。
- 键盘密集复核：J/K 移动、Enter 合并、C/R 确认或忽略，支持批量操作。
- 合并时逐字段并排展示 A / B 来源，每个冲突字段可单独保留或拼接。
- 保存原始记录、字段来源选择、合并结果和忽略动作，形成完整审计轨迹。
- 支持撤销重做、离线 localStorage 保存和 JSON 核对包导出。
- 大量记录采用分批窗口渲染，匹配计算限制每条记录的候选数，避免一次挂载全部行。

## 技术栈

- Qwik 1.20
- TypeScript 5.9
- Qwik UI Headless `@qwik-ui/headless`
- Vite 7

## 开发

```bash
npm install
npm run dev
```

开发服务使用 Vite 默认端口，不在源码中硬编码宿主端口。

## 生产构建

```bash
npm run build
npm run preview
```

静态产物输出到 `dist/`。

## Docker

```bash
docker build -t sologsb-1020 .
docker run --rm -p 10020:80 sologsb-1020
```

nginx 在容器内监听 `80`，宿主端口 `10020` 由根端口表或运行命令映射。

## 数据说明

记录和审计轨迹保存在当前浏览器。导入新记录后自动重新计算候选匹配，但不会自动确认或覆盖任何字段。
