/**
 * 真机环境测试入口（`pnpm test:env`）。
 *
 * 与 run-tests.ts 分开：默认套件必须任何机器都能跑；这一份依赖本机
 * 的 llama.cpp 安装与模型文件，缺文件时用例自行 skip。
 */

import "./env.test.ts";
