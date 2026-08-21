import { $, Project, Script, $ui, $message, $modal } from 'easy-us';
import { playbackRate, volume, restudy } from '../utils/configs';
import { waitForMedia, waitForElement, waitFor } from '../utils/study';
import { $msg, playMedia } from '../utils';
import { CommonProject } from './common';
import { $console } from './background';

const state = {
	study: {
		currentMedia: undefined as HTMLMediaElement | undefined,
		manualPaused: false,
		isRunning: false
	}
};

let audioCtx: AudioContext | null = null;

/**
 * 彻底防止浏览器休眠标签页与后台降频（WebAudio 振荡器保活 + WakeLock 锁）
 */
function keepTabAlive() {
	try {
		if (!audioCtx) {
			const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
			if (AudioContextClass) {
				audioCtx = new AudioContextClass();
				const oscillator = audioCtx.createOscillator();
				const gainNode = audioCtx.createGain();
				// 极微弱无声音频（人耳完全不可闻，但在系统音频管线中保持活跃，赋予标签页最高后台执行权限）
				gainNode.gain.value = 0.00001;
				oscillator.type = 'sine';
				oscillator.frequency.value = 440;
				oscillator.connect(gainNode);
				gainNode.connect(audioCtx.destination);
				oscillator.start();
			}
		}

		if (audioCtx && audioCtx.state === 'suspended') {
			audioCtx.resume().catch(() => {});
		}

		// 页面任意交互时自动激活 AudioContext
		const resumeHandler = () => {
			if (audioCtx && audioCtx.state === 'suspended') {
				audioCtx.resume().catch(() => {});
			}
		};
		window.addEventListener('click', resumeHandler, { once: true });
		window.addEventListener('keydown', resumeHandler, { once: true });

		// Screen Wake Lock API
		if ('wakeLock' in navigator) {
			(navigator as any).wakeLock?.request?.('screen')?.catch?.(() => {});
		}
	} catch (e) {
		console.warn('[SmartEdu] 保活初始化失败:', e);
	}
}

/**
 * 彻底劫持失焦与切屏暂停检测（EventTarget 拦截 + 属性欺骗 + 焦点伪造 + 捕获阻断 + HTMLMediaElement.pause 拦截）
 */
function hookVisibilityAndBlur() {
	const win = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as any;

	// 1. 劫持 HTMLMediaElement.prototype.pause，彻底无视页面在后台触发的自动暂停
	try {
		const targetMediaProto = win.HTMLMediaElement?.prototype || (typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.prototype : null);
		if (targetMediaProto && targetMediaProto.pause && !targetMediaProto.__smartedu_pause_hooked__) {
			targetMediaProto.__smartedu_pause_hooked__ = true;
			const originPause = targetMediaProto.pause;
			targetMediaProto.pause = function () {
				// 只有当用户显式标记手动暂停时才执行真实暂停，忽略后台/切屏失焦的自动暂停
				if (state.study.manualPaused) {
					return originPause.apply(this, arguments as any);
				}
				// 保持播放状态，返回成功空 Promise
				return Promise.resolve();
			};
		}
	} catch (e) {
		console.warn('[SmartEdu] 劫持 pause 失败:', e);
	}

	if (win.__smartedu_hooked__) return;
	try {
		win.__smartedu_hooked__ = true;
	} catch (e) {}

	try {
		const blockedEvents = [
			'visibilitychange',
			'webkitvisibilitychange',
			'blur',
			'focusout',
			'pagehide'
		];

		// 2. 拦截 EventTarget.prototype.addEventListener 注册失焦/切屏监听
		const targetPrototypes = [
			win.EventTarget?.prototype,
			win.Window?.prototype,
			win.Document?.prototype,
			win.HTMLDocument?.prototype
		].filter(Boolean);

		for (const proto of targetPrototypes) {
			if (proto && proto.addEventListener) {
				const originAdd = proto.addEventListener;
				proto.addEventListener = function (type: string, listener: any, options: any) {
					if (typeof type === 'string' && blockedEvents.includes(type.toLowerCase())) {
						return;
					}
					return originAdd.call(this, type, listener, options);
				};
			}
		}

		// 3. 伪造 document.hidden 与 document.visibilityState
		const docTargets = [
			win.document,
			win.Document?.prototype,
			win.HTMLDocument?.prototype,
			document,
			typeof Document !== 'undefined' ? Document.prototype : null
		].filter(Boolean);

		for (const target of docTargets) {
			try {
				Object.defineProperty(target, 'hidden', {
					get: () => false,
					configurable: true
				});
				Object.defineProperty(target, 'visibilityState', {
					get: () => 'visible',
					configurable: true
				});
				Object.defineProperty(target, 'webkitHidden', {
					get: () => false,
					configurable: true
				});
				Object.defineProperty(target, 'webkitVisibilityState', {
					get: () => 'visible',
					configurable: true
				});
			} catch (e) {}
		}

		// 4. 伪造 document.hasFocus 始终返回 true
		try {
			if (win.document) {
				win.document.hasFocus = () => true;
			}
			if (typeof document !== 'undefined') {
				document.hasFocus = () => true;
			}
		} catch (e) {}

		// 5. 清空全局 onblur 与 onvisibilitychange
		try {
			win.onblur = null;
			win.onpagehide = null;
			if (win.document) {
				win.document.onvisibilitychange = null;
			}
		} catch (e) {}

		// 6. 捕获阶段事件阻断（多重保险）
		const stopPropagation = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();
		};

		for (const evt of blockedEvents) {
			try {
				win.addEventListener?.(evt, stopPropagation, true);
				win.document?.addEventListener?.(evt, stopPropagation, true);
				window.addEventListener(evt, stopPropagation, true);
				document.addEventListener(evt, stopPropagation, true);
			} catch (e) {}
		}
	} catch (e) {
		console.warn('[SmartEdu] 劫持切屏检测失败:', e);
	}
}

// 模块加载时立即执行
hookVisibilityAndBlur();
keepTabAlive();

/**
 * 展开所有折叠的课程目录
 */
async function expandAllChapters() {
	const inactiveHeaders = Array.from(
		document.querySelectorAll<HTMLElement>(
			'.fish-collapse-item:not(.fish-collapse-item-active) .fish-collapse-header, .fish-collapse-item:not(.fish-collapse-item-active) > div:first-child'
		)
	);
	for (const header of inactiveHeaders) {
		try {
			header.click();
		} catch (e) {}
		await $.sleep(100);
	}
}

/**
 * 获取所有小节资源元素
 */
function getResourceItems(): HTMLElement[] {
	return Array.from(document.querySelectorAll<HTMLElement>('.resource-item'));
}

/**
 * 判断小节是否已经完成
 */
function isItemFinished(item: HTMLElement): boolean {
	const icon = item.querySelector('.status-icon i, .status-icon span, .iconfont, [class*="status"]');
	if (icon) {
		const title = icon.getAttribute('title') || '';
		const className = icon.className || '';
		if (
			title.includes('已学完') ||
			title.includes('已完成') ||
			className.includes('icon_checkbox_fill') ||
			className.includes('icon-yixuewan')
		) {
			return true;
		}
	}
	const text = item.innerText || '';
	if (text.includes('已学完') || text.includes('已完成') || text.includes('100%')) {
		return true;
	}
	return false;
}

/**
 * 判断小节是否正在进行中或当前选中
 */
function isItemProcessing(item: HTMLElement): boolean {
	const icon = item.querySelector('.status-icon i, .status-icon span, .iconfont, [class*="status"]');
	if (icon) {
		const title = icon.getAttribute('title') || '';
		const className = icon.className || '';
		if (title.includes('进行中') || className.includes('icon_processing_fill')) {
			return true;
		}
	}
	if (item.querySelector('.coursePlayingIcon, [class*="PlayingIcon"]')) {
		return true;
	}
	return item.classList.contains('active') || item.classList.contains('selected');
}

/**
 * 处理视频中途弹出的题目或确认弹窗
 */
function handlePopups() {
	try {
		// 1. 选择题选项自动勾选
		const options = document.querySelectorAll<HTMLElement>(
			'.nqti-option, .fish-radio-wrapper:not(.fish-radio-wrapper-checked), .fish-checkbox-wrapper:not(.fish-checkbox-wrapper-checked)'
		);
		if (options.length > 0) {
			options[0].click();
		}

		// 2. 填空题输入框填充占位
		const inputForm = document.querySelector<HTMLElement>('.index-module_box_blt8G');
		if (inputForm) {
			const inputs = inputForm.querySelectorAll<HTMLInputElement>('input');
			inputs.forEach((input) => {
				if (!input.value) {
					input.value = ' ';
					input.dispatchEvent(new Event('input', { bubbles: true }));
				}
			});
		}

		// 3. 弹窗确认/提交按钮
		const btns = document.querySelectorAll<HTMLElement>(
			[
				'.index-module_footer_wewZ2 .fish-btn',
				'.fish-modal-confirm-btns .fish-btn',
				'.fish-modal-footer .fish-btn-primary',
				'.fish-modal-wrap .fish-btn-primary',
				'.fish-modal-confirm-confirm'
			].join(',')
		);
		for (const btn of Array.from(btns)) {
			if (btn.offsetParent !== null) {
				btn.click();
			}
		}
	} catch (e) {
		// ignore
	}
}

/**
 * 应用音量与倍速设置（精准单次同步，避免循环点击翻转）
 */
function applyMediaSettings(video: HTMLVideoElement, cfg: { playbackRate: number | string; volume: number }) {
	const targetRate = parseFloat(cfg.playbackRate.toString());

	// 1. 设置 video 属性
	try {
		video.playbackRate = targetRate;
	} catch (e) {}

	// 2. 联动 videojs 静音按钮
	const muteBtn = document.querySelector<HTMLElement>('.vjs-mute-control');
	if (cfg.volume === 0) {
		try {
			video.muted = true;
			video.volume = 0;
		} catch (e) {}

		// 如果当前处于有声状态（按钮提示“静音”），点击一次切换为静音；已经是“取消静音”则不点击
		if (
			muteBtn &&
			(muteBtn.getAttribute('title') === '静音' || muteBtn.innerText.includes('静音')) &&
			!muteBtn.innerText.includes('取消') &&
			muteBtn.getAttribute('title') !== '取消静音'
		) {
			muteBtn.click();
		}
	} else {
		// 如果需要有声，且当前处于静音（按钮提示“取消静音”），点击一次恢复声音
		if (
			muteBtn &&
			(muteBtn.getAttribute('title') === '取消静音' || muteBtn.innerText.includes('取消静音'))
		) {
			muteBtn.click();
		}
		try {
			video.muted = false;
			video.volume = cfg.volume;
		} catch (e) {}
	}

	// 3. 联动 videojs 倍速菜单（仅当未处于目标倍速时点击）
	const menuItems = Array.from(document.querySelectorAll<HTMLElement>('.vjs-playback-rate .vjs-menu-item'));
	const targetText = `${targetRate}x`;
	const matchedItem = menuItems.find((it) => it.textContent?.includes(targetText));
	if (
		matchedItem &&
		!matchedItem.className.includes('vjs-selected') &&
		matchedItem.getAttribute('aria-checked') !== 'true'
	) {
		matchedItem.click();
	}
}

/**
 * 触发播放并保持播放
 */
async function startAndKeepPlaying(video: HTMLVideoElement, cfg: { playbackRate: number | string; volume: number }) {
	// 1. 触发保活
	keepTabAlive();

	// 2. 设置倍速与静音
	applyMediaSettings(video, cfg);

	// 3. 点击大播放按钮（videojs 居中大按钮）
	const bigPlay = document.querySelector<HTMLElement>('.vjs-big-play-button, .vjs-play-control');
	if (bigPlay && bigPlay.offsetParent !== null) {
		try {
			bigPlay.click();
		} catch (e) {}
	}

	// 4. 调用原生 play()
	try {
		await video.play();
	} catch (e) {
		const videoContainer = document.querySelector<HTMLElement>('.video-js, .fish-video, video');
		videoContainer?.click();
		video.play().catch(() => {});
	}
}

/**
 * 观看视频的核心逻辑
 */
async function watchVideo(
	cfg: {
		playbackRate: number | string;
		volume: number;
		autoSkipQuiz: boolean;
	},
	title: string
) {
	// 等待视频出现
	let video = (await waitForMedia({
		videoSelector: 'video.vjs-tech, video',
		timeout: 30 * 1000
	})) as HTMLVideoElement;

	if (!video) {
		throw new Error('未找到视频元素');
	}

	state.study.currentMedia = video;
	state.study.manualPaused = false;

	// 等待视频元数据加载
	await waitFor(() => video.duration > 0 || video.readyState >= 1, { timeout_seconds: 10, check_period_ms: 500 });

	await startAndKeepPlaying(video, cfg);

	return new Promise<void>((resolve) => {
		let isDone = false;
		let lastLogTime = 0;

		const finish = async () => {
			if (isDone) return;
			isDone = true;
			clearInterval(intervalId);
			$message.info(`${title} 播放完成，正在等待学时同步...`);
			await $.sleep(4000);
			resolve();
		};

		// 同步监听 pause 事件：一旦被任何第三方触发暂停，0毫秒无延时立即恢复播放！
		const syncPauseHandler = () => {
			if (isDone) return;
			if (!state.study.manualPaused && !video.ended) {
				try {
					video.play();
				} catch (e) {}
			}
		};
		video.addEventListener('pause', syncPauseHandler);

		const intervalId = setInterval(async () => {
			if (isDone) return;

			// 持续触发音频与唤醒锁保活
			keepTabAlive();

			// 如果视频元素被替换，重新获取当前视频
			if (!video.isConnected) {
				const newVideo = document.querySelector<HTMLVideoElement>('video');
				if (newVideo) {
					video = newVideo;
					state.study.currentMedia = video;
					video.addEventListener('pause', syncPauseHandler);
					await startAndKeepPlaying(video, cfg);
				}
				return;
			}

			// 处理弹窗题目
			if (cfg.autoSkipQuiz) {
				handlePopups();
			}

			// 持续应用静音和倍速设置
			applyMediaSettings(video, cfg);

			// 如果意外暂停且非用户手动暂停，恢复播放
			if (video.paused && !state.study.manualPaused && !video.ended) {
				await startAndKeepPlaying(video, cfg);
			}

			// 输出进度日志（每 10 秒）
			const now = Date.now();
			if (now - lastLogTime > 10000 && video.duration > 0) {
				lastLogTime = now;
				const cur = Math.floor(video.currentTime);
				const dur = Math.floor(video.duration);
				const pct = ((cur / dur) * 100).toFixed(1);
				$console.info(`[SmartEdu] ${title} 进度: ${cur}s / ${dur}s (${pct}%)`);
			}

			// 严谨的完成条件：必须是视频自身确实播放到了结尾（剩余 <= 3秒 且已播放超过 5 秒，或者原生 ended 事件）
			const playedEnough = video.currentTime > 5;
			const isNearEnd = playedEnough && video.duration > 0 && video.duration - video.currentTime <= 3;

			if (video.ended || isNearEnd) {
				video.removeEventListener('pause', syncPauseHandler);
				await finish();
			}
		}, 1000);
	});
}

export const SmartEduProject = Project.create({
	name: '国家智慧教育平台',
	domains: ['smartedu.cn', 'zxx.edu.cn'],
	scripts: {
		guide: new Script({
			name: '💡 使用提示',
			matches: [
				['专题培训首页', '/training/'],
				['教师研修导航', '/teacherTrainingNav'],
				['课程目录页', '/teacherTraining/courseIndex'],
				['智慧中小学主页', 'basic.smartedu.cn']
			],
			namespace: 'smartedu.study.guide',
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'进入任意专题培训或课程详情页，即可开始自动学习。',
						'视频播放页支持倍速调节、后台播放及小节自动跳转。'
					]).outerHTML
				}
			},
			onstart() {
				hookVisibilityAndBlur();
				keepTabAlive();
			},
			oncomplete() {
				hookVisibilityAndBlur();
				keepTabAlive();
				CommonProject.scripts.render.methods.pin(this);
			}
		}),
		study: new Script({
			name: '📚 课程学习',
			namespace: 'smartedu.study.main',
			matches: [
				['教师研修课程学习', '/teacherTraining/courseDetail'],
				['专题培训学习', '/training/']
			],
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'请勿在使用过程中最小化浏览器，可置于后台运行。',
						'脚本支持倍速播放、静音、防切屏暂停、自动跳过内嵌测验。',
						'当前课程所有小节学完后会自动停止。'
					]).outerHTML
				},
				playbackRate: playbackRate,
				volume: volume,
				restudy: restudy,
				autoNext: {
					label: '自动下一节',
					attrs: { type: 'checkbox', title: '当前视频/资源学完后自动进入下一小节' },
					defaultValue: true
				},
				autoSkipQuiz: {
					label: '自动跳过测验/弹窗',
					attrs: { type: 'checkbox', title: '自动作答或跳过视频中途弹出的测试题目与提示框' },
					defaultValue: true
				},
				readSpeed: {
					label: '文档/非视频等待时间（秒）',
					attrs: { type: 'number', step: '1', min: '1', max: '60' },
					defaultValue: 3
				}
			},
			onstart() {
				hookVisibilityAndBlur();
				keepTabAlive();
			},
			oncomplete() {
				hookVisibilityAndBlur();
				keepTabAlive();
				CommonProject.scripts.render.methods.pin(this);

				this.onConfigChange('playbackRate', (rate) => {
					if (state.study.currentMedia) {
						applyMediaSettings(state.study.currentMedia as HTMLVideoElement, this.cfg);
					}
				});
				this.onConfigChange('volume', (v) => {
					if (state.study.currentMedia) {
						applyMediaSettings(state.study.currentMedia as HTMLVideoElement, this.cfg);
					}
				});

				// 如果在培训列表或非课程学习页，仅提示并退出
				if (location.pathname.includes('/training/') && !location.pathname.includes('courseDetail')) {
					$message.info('请点击进入任意课程开始自动学习');
					return;
				}

				const study = async () => {
					if (state.study.isRunning) return;
					state.study.isRunning = true;

					try {
						// 等待课程目录容器加载
						await waitForElement('.fish-collapse, .tcourse-catalog, .resource-item', { timeout_seconds: 15 });
						await expandAllChapters();
						await $.sleep(1000);

						while (true) {
							await expandAllChapters();
							const items = getResourceItems();
							if (items.length === 0) {
								$msg.warn('未找到课程小节列表，请确认是否在课程详情页。');
								break;
							}

							// 找到当前正在进行的未完成小节，或者下一个未完成小节
							let targetIdx = -1;

							if (this.cfg.restudy) {
								targetIdx = items.findIndex((el) => isItemProcessing(el));
								if (targetIdx === -1) targetIdx = 0;
							} else {
								const currentActiveIdx = items.findIndex((el) => isItemProcessing(el));
								if (currentActiveIdx !== -1 && !isItemFinished(items[currentActiveIdx])) {
									targetIdx = currentActiveIdx;
								} else {
									targetIdx = items.findIndex((el) => !isItemFinished(el));
								}
							}

							if (targetIdx === -1) {
								$modal.alert({ title: '学习提示', content: '检测到当前课程所有小节已学习完毕！' });
								$message.success('当前课程所有小节已学习完毕！');
								break;
							}

							const targetItem = items[targetIdx];
							const title = targetItem.innerText?.trim().split('\n')[0] || `第 ${targetIdx + 1} 节`;

							// 只有当目标不是当前播放项时才执行点击跳转
							if (!isItemProcessing(targetItem)) {
								$message.info(`正在进入小节：${title}`);
								targetItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
								targetItem.click();
								await $.sleep(3000);
							}

							$message.info(`正在学习：${title}`);

							// 检测页面是否有视频
							const videoEl = await waitFor(() => document.querySelector<HTMLVideoElement>('video'), {
								timeout_seconds: 8,
								check_period_ms: 500
							});

							if (videoEl) {
								await watchVideo(
									{
										playbackRate: this.cfg.playbackRate,
										volume: this.cfg.volume,
										autoSkipQuiz: this.cfg.autoSkipQuiz
									},
									title
								);
							} else {
								$message.info(`${title} 为文档/非视频资源，等待 ${this.cfg.readSpeed} 秒后继续...`);
								await $.sleep(this.cfg.readSpeed * 1000);
							}

							if (!this.cfg.autoNext) {
								$message.info('自动下一节已关闭，停止自动学习。');
								break;
							}

							await $.sleep(2000);
						}
					} catch (e) {
						$message.error(`学习过程发生异常: ${String(e)}`);
						$console.error(`[SmartEdu] 学习异常: ${String(e)}`);
					} finally {
						state.study.isRunning = false;
					}
				};

				study();
			}
		})
	}
});
