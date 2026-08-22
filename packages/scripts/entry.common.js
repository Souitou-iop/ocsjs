/* eslint-disable no-undef */
/// <reference path="./global.d.ts" />

// Polyfills for optional GM APIs
if (typeof Reflect.get(globalThis, 'GM_getTab') === 'undefined') {
	globalThis.GM_getTab = (cb) => cb?.({});
}
if (typeof Reflect.get(globalThis, 'GM_saveTab') === 'undefined') {
	globalThis.GM_saveTab = () => {};
}
if (typeof Reflect.get(globalThis, 'GM_listValues') === 'undefined') {
	globalThis.GM_listValues = () => [];
}
if (typeof Reflect.get(globalThis, 'GM_deleteValue') === 'undefined') {
	globalThis.GM_deleteValue = () => {};
}
if (typeof Reflect.get(globalThis, 'GM_notification') === 'undefined') {
	globalThis.GM_notification = () => {};
}
if (typeof Reflect.get(globalThis, 'GM_addValueChangeListener') === 'undefined') {
	globalThis.GM_addValueChangeListener = () => 0;
}
if (typeof Reflect.get(globalThis, 'GM_removeValueChangeListener') === 'undefined') {
	globalThis.GM_removeValueChangeListener = () => {};
}
if (typeof Reflect.get(globalThis, 'unsafeWindow') === 'undefined') {
	globalThis.unsafeWindow = window;
}

// 核心环境检测
if (
	[
		'GM_setValue',
		'GM_getValue',
		'GM_xmlhttpRequest'
	].some((api) => typeof Reflect.get(globalThis, api) === 'undefined')
) {
	const open = confirm(
		`OCS网课脚本不支持当前的脚本管理器（${typeof GM_info !== 'undefined' ? GM_info.scriptHandler : '未知'}）。` +
			'请前往 https://docs.ocsjs.com/docs/script 下载指定的脚本管理器，例如 “Scriptcat 脚本猫” 或者 “Tampermonkey 油猴”'
	);

	if (open) {
		window.location.href = 'https://docs.ocsjs.com/docs/script';
	}
	return;
}

const { start, definedProjects, CommonProject, RenderScript } = OCS;

const infos = typeof GM_info !== 'undefined' ? GM_info : { script: { version: '4.16.0' } };

(function () {
	'use strict';

	const projects = definedProjects();

	// 运行脚本
	start({
		projects: projects,
		renderConfig: {
			renderScript: RenderScript,
			styles: [typeof STYLE !== 'undefined' ? STYLE : ''],
			defaultPanelName: CommonProject.scripts.guide.namespace,
			title: `OCS-${infos.script.version}`
		},
		updatePage: 'https://docs.ocsjs.com/docs/update'
	});
})();
