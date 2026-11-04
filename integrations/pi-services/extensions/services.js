/**
 * Pi 扩展入口：后台服务与作业管理（service_* 工具 + /services 命令 + 状态栏）。
 *
 * typebox 由 Pi 作为宿主包提供（见 Pi docs/packages.md「Declare dependencies」），只在这里 import，
 * 其余逻辑在 ../lib/ 下且不依赖任何 Pi 包，便于在仓库里单测。
 * 工厂里不启动进程或定时器：状态栏刷新只在 session_start 且有 UI 时开始（Pi 扩展生命周期约定）。
 */
import { Type } from 'typebox';
import { registerServices } from '../lib/register.js';

export default function piServices(pi) {
	registerServices(pi, Type);
}
