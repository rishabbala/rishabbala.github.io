/*
A rolling ASCII arcana strip in each gutter, motion control, and section navigation.
Last modified: 2026-10-03 12:20
*/

// Preserve the visitor's motion preference without requiring local storage.
(() => {
	"use strict";
	const root = document.documentElement;
	const motionButton = document.querySelector(".motion-toggle");
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
	let userPaused = false;
	try {
		userPaused = localStorage.getItem("rishab-motion-paused") === "true";
	} catch {
		userPaused = false;
	}
	const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

	// Render a packed ink strip as live text so glyphs stay sharp at any zoom level.
	function createGutterArt() {
		const canvas = document.querySelector("#art-background");
		const stage = canvas?.parentElement;
		const context = canvas?.getContext("2d");
		const paper = document.querySelector(".notebook");
		if (!context || !stage || !paper) return null;
		stage.classList.add("is-loading");
		const script = document.querySelector('script[src$="site.js"]');
		const galleryURL = new URL("assets/portraits/", script.src);
		const config = { columns: 160, rows: 200, cellRatio: 0.6, glyphs: " .,:;~!i1tfLCG0@", inkRamp: ["#0c1220"] };
		let buildSeconds = 20;
		let holdSeconds = 5;
		let exitSeconds = 5;
		let catalog = [];
		let metrics = null;
		let art = { left: null, right: null };
		let pending = false;
		let pair = [0, 1];
		let previousPair = [];
		let nextArt = null;
		let sceneTime = 0;
		let lastDrawnPhase = null;
		let frame = null;
		let lastFrame = 0;
		let running = false;
		let resizeTimer = null;
		const cache = new Map();

		// Measure the monospace advance once so one glyph always fills one cell.
		const probe = document.createElement("canvas").getContext("2d");
		probe.font = '100px ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace';
		const advance = probe.measureText("0").width / 100 || config.cellRatio;

		// Cover the whole margin beside the paper, scaling the cell size with zoom.
		function measure() {
			const ratio = Math.min(window.devicePixelRatio || 1, 3);
			const deviceWidth = Math.max(1, Math.round(stage.clientWidth * ratio));
			const deviceHeight = Math.max(1, Math.round(stage.clientHeight * ratio));
			const paperBox = paper.getBoundingClientRect();
			const left = clamp(Math.round(paperBox.left * ratio), 0, deviceWidth);
			const right = clamp(Math.round(paperBox.right * ratio), 0, deviceWidth);
			const band = Math.max(0, Math.min(left, deviceWidth - right));
			const cellWidth = clamp(Math.max(band / config.columns, (deviceHeight * config.cellRatio) / config.rows), 2, 14);
			const cellHeight = cellWidth / advance;
			return {
				deviceWidth, deviceHeight, cellWidth, cellHeight, band,
				visible: Math.min(paperBox.left, stage.clientWidth - paperBox.right) >= 88,
				leftClip: 0, rightClip: deviceWidth - band,
			};
		}

		// Paint the whole ink field as live text, grouped by ink colour.
		function paint(levels, box) {
			const strip = document.createElement("canvas");
			strip.width = Math.max(1, Math.round(config.columns * box.cellWidth));
			strip.height = Math.max(1, Math.round(config.rows * box.cellHeight));
			const brush = strip.getContext("2d");
			brush.font = `${(box.cellWidth / advance).toFixed(3)}px ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace`;
			brush.textAlign = "center";
			brush.textBaseline = "middle";
			for (let tone = 1; tone < config.inkRamp.length; tone++) {
				brush.fillStyle = config.inkRamp[tone];
				brush.beginPath();
				for (let row = 0; row < config.rows; row++) {
					const source = row * config.columns;
					for (let column = 0; column < config.columns; column++) {
						if (levels[source + column] !== tone) continue;
						brush.fillText(config.glyphs[tone], (column + 0.5) * box.cellWidth, (row + 0.5) * box.cellHeight);
					}
				}
				brush.fill();
			}
			return strip;
		}

		// Fetch one hero's ink field and rasterize it for the current viewport.
		async function loadArtwork(index) {
			const record = catalog[index];
			if (cache.has(index)) return cache.get(index);
			const promise = (async () => {
				const response = await fetch(new URL(record.file, galleryURL));
				if (!response.ok) throw new Error(`Artwork ${record.id} is unavailable.`);
				const levels = new Uint8Array(await response.arrayBuffer());
				if (levels.length !== config.columns * config.rows) throw new Error(`Artwork ${record.id} is truncated.`);
				const box = measure();
				metrics = box;
				return { levels, id: record.id, hero: record.hero, box, canvas: paint(levels, box) };
			})();
			cache.set(index, promise);
			return promise;
		}

		// Clip to the margin on one side of the paper column and align drawing to it.
		function openGutter(side) {
			context.save();
			context.beginPath();
			context.rect(side ? metrics.rightClip : metrics.leftClip, 0, metrics.band, metrics.deviceHeight);
			context.clip();
			context.translate(side ? metrics.rightClip : metrics.leftClip, 0);
		}

		// Draw one row slice of a figure inside the currently open gutter.
		function drawSlice(picture, row, alpha, offsetY, zoom) {
			const { canvas: source, box } = picture;
			context.globalAlpha = alpha;
			context.drawImage(
				source, 0, row * box.cellHeight, source.width, box.cellHeight,
				(box.band - source.width * zoom) / 2, (box.deviceHeight - source.height * zoom) / 2 + row * box.cellHeight * zoom + offsetY,
				source.width * zoom, box.cellHeight * zoom
			);
		}

		// Wash the whole figure in faintly, then overwrite row by row from the middle outward.
		function drawRows(picture, progress, entering) {
			const rows = Math.round(picture.canvas.height / picture.box.cellHeight);
			const stagger = entering ? 0.9 : 0.76;
			const wash = entering ? 0.15 + 0.4 * progress : 0;
			for (let row = 0; row < rows; row++) {
				const fraction = entering ? Math.abs(row - (rows - 1) / 2) / ((rows - 1) / 2) : row / (rows - 1);
				const travel = clamp((progress - fraction * stagger) / (1 - stagger), 0, 1);
				const eased = 1 - Math.pow(1 - travel, 3);
				const alpha = entering ? clamp(wash + eased, 0, 1) : 1 - eased;
				if (alpha <= 0.01) continue;
				const roll = entering ? 1 - eased : eased;
				drawSlice(picture, row, alpha, (entering ? 16 : -46) * roll * metrics.deviceHeight / 1000, 1 + 0.03 * roll);
			}
		}

		// Hold both finished figures completely still for five seconds.
		function draw() {
			if (!art.left || !metrics) return;
			const phase = sceneTime < buildSeconds ? "build" : sceneTime < buildSeconds + holdSeconds ? "hold" : "exit";
			if (phase === "hold" && lastDrawnPhase === "hold") return;
			context.clearRect(0, 0, metrics.deviceWidth, metrics.deviceHeight);
			if (!metrics.visible) {
				lastDrawnPhase = phase;
				canvas.dataset.phase = phase;
				return;
			}
			const progress = phase === "build" ? sceneTime / buildSeconds : phase === "exit" ? (sceneTime - buildSeconds - holdSeconds) / exitSeconds : 1;
			for (const side of [0, 1]) {
				openGutter(side);
				const picture = side ? art.right : art.left;
				if (phase === "hold") {
					const rows = Math.round(picture.canvas.height / picture.box.cellHeight);
					for (let row = 0; row < rows; row++) drawSlice(picture, row, 1, 0, 1);
				} else {
					drawRows(picture, Math.min(1, progress), phase === "build");
				}
				context.restore();
			}
			context.globalAlpha = 1;
			lastDrawnPhase = phase;
			canvas.dataset.artwork = `${art.left.id}+${art.right.id}`;
			canvas.dataset.phase = phase;
			canvas.dataset.cell = String(Math.round(metrics.cellWidth * 100) / 100);
			canvas.dataset.band = String(Math.round(metrics.band));
			canvas.dataset.progress = progress.toFixed(3);
		}

		// Choose two different heroes, avoiding what is on screen and what showed last.
		function nextPair() {
			const avoid = new Set([...pair, ...previousPair]);
			if (catalog.length - avoid.size < 2) return [0, 1];
			const pick = () => {
				const options = catalog.map((_, index) => index).filter((index) => !avoid.has(index));
				return options[Math.floor(Math.random() * options.length)];
			};
			const left = pick();
			avoid.add(left);
			return [left, pick()];
		}

		// Stage the next random pair while the current figures are resting.
		function prepareNext() {
			if (!running || !art.left || pending || nextArt || !catalog.length) return;
			pending = true;
			const choice = nextPair();
			Promise.all(choice.map((index) => loadArtwork(index))).then((pictures) => {
				nextArt = { left: pictures[0], right: pictures[1], pair: choice };
				pending = false;
			}).catch(() => {
				pending = false;
			});
		}

		// Run at 25 frames per second and do no animation work in a hidden tab.
		function tick(now) {
			frame = null;
			if (!running || !art.left || document.hidden) return;
			if (!lastFrame || now - lastFrame >= 40) {
				const delta = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 0;
				lastFrame = now;
				sceneTime += delta;
				const cycleSeconds = buildSeconds + holdSeconds + exitSeconds;
				if (!nextArt) sceneTime = Math.min(sceneTime, cycleSeconds);
				if (sceneTime >= cycleSeconds && nextArt) {
					const finished = art;
					previousPair = pair;
					pair = nextArt.pair;
					art = { left: nextArt.left, right: nextArt.right };
					nextArt = null;
					metrics = art.left.box;
					sceneTime = 0;
					lastDrawnPhase = null;
					finished.left.canvas.width = finished.left.canvas.height = 0;
					finished.right.canvas.width = finished.right.canvas.height = 0;
					prune();
					prepareNext();
				} else if (sceneTime >= cycleSeconds && !pending) {
					prepareNext();
				}
				draw();
			}
			frame = requestAnimationFrame(tick);
		}

		// A single scheduled frame makes pause and tab-visibility changes immediate.
		function schedule() {
			if (running && art.left && !document.hidden) {
				if (frame === null) frame = requestAnimationFrame(tick);
			} else {
				if (frame !== null) cancelAnimationFrame(frame);
				frame = null;
				lastFrame = 0;
			}
		}

		// Drop cached rasters that are neither on screen nor staged next.
		function prune() {
			const keep = new Set([...pair, ...(nextArt ? nextArt.pair : [])]);
			for (const index of cache.keys()) {
				if (!keep.has(index)) cache.delete(index);
			}
		}

		// Repaint both current heroes at the new pixel size after a quiet period.
		function remeasure() {
			if (!catalog.length || !art.left) return;
			cache.clear();
			Promise.all(pair.map((index) => loadArtwork(index))).then((pictures) => {
				art = { left: pictures[0], right: pictures[1] };
				metrics = pictures[0].box;
				lastDrawnPhase = null;
				prune();
				draw();
				prepareNext();
			}).catch(() => {});
		}

		// Debounce viewport changes so dragging a window does not thrash the rasterizer.
		function onResize() {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(remeasure, 180);
			const ratio = Math.min(window.devicePixelRatio || 1, 3);
			canvas.width = Math.max(1, Math.round(stage.clientWidth * ratio));
			canvas.height = Math.max(1, Math.round(stage.clientHeight * ratio));
			lastDrawnPhase = null;
		}
		canvas.width = Math.max(1, Math.round(stage.clientWidth * Math.min(window.devicePixelRatio || 1, 3)));
		canvas.height = Math.max(1, Math.round(stage.clientHeight * Math.min(window.devicePixelRatio || 1, 3)));
		window.addEventListener("resize", onResize, { passive: true });
		document.addEventListener("visibilitychange", schedule);

		// Resolve assets relative to the script so subdirectory deployments also work.
		(async () => {
			const response = await fetch(new URL("manifest.json", galleryURL));
			if (!response.ok) throw new Error("The local artwork catalog is unavailable.");
			const manifest = await response.json();
			if (!Array.isArray(manifest.frames) || !manifest.frames.length) throw new Error("The artwork catalog is empty.");
			catalog = manifest.frames;
			config.columns = manifest.columns || config.columns;
			config.rows = manifest.rows || config.rows;
			config.cellRatio = manifest.cellRatio || config.cellRatio;
			config.glyphs = manifest.glyphs || config.glyphs;
			config.inkRamp = manifest.inkRamp || config.inkRamp;
			buildSeconds = Math.max(1, Number(manifest.buildSeconds) || 20);
			holdSeconds = Math.max(1, Number(manifest.holdSeconds) || 5);
			exitSeconds = Math.max(1, Number(manifest.exitSeconds) || 5);
			pair = nextPair();
			const pictures = await Promise.all(pair.map((index) => loadArtwork(index)));
			art = { left: pictures[0], right: pictures[1] };
			canvas.width = metrics.deviceWidth;
			canvas.height = metrics.deviceHeight;
			canvas.dataset.collectionSize = String(catalog.length);
			if (!running) sceneTime = buildSeconds;
			draw();
			stage.classList.remove("is-loading");
			stage.classList.add("is-ready");
			prepareNext();
			schedule();
		})().catch(() => {
			stage.classList.remove("is-ready", "is-loading");
		});
		return { setRunning(value) { running = value; prepareNext(); schedule(); } };
	}
	const gallery = createGutterArt();

	// Apply the same motion preference to the gallery and all decorative CSS.
	function applyMotion() {
		const paused = userPaused || reducedMotion.matches;
		root.classList.toggle("motion-paused", paused);
		gallery?.setRunning(!paused);
		if (!motionButton) return;
		motionButton.hidden = false;
		motionButton.disabled = reducedMotion.matches;
		motionButton.setAttribute("aria-pressed", String(paused));
		motionButton.textContent = reducedMotion.matches ? "Motion reduced" : paused ? "Resume motion" : "Pause motion";
		motionButton.title = reducedMotion.matches ? "Your device requests reduced motion." : "Pause or resume decorative animations.";
	}
	motionButton?.addEventListener("click", () => {
		userPaused = !userPaused;
		try {
			localStorage.setItem("rishab-motion-paused", String(userPaused));
		} catch {
			userPaused = Boolean(userPaused);
		}
		applyMotion();
	});
	reducedMotion.addEventListener("change", applyMotion);
	applyMotion();

	// Reveal reading blocks once without hiding the no-JavaScript version.
	if ("IntersectionObserver" in window) {
		const observer = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				entry.target.classList.add("is-visible");
				observer.unobserve(entry.target);
			}
		}, { threshold: 0.08 });
		document.querySelectorAll(".hero, .research-compass, .section-heading, .entry, .news-list").forEach((element) => observer.observe(element));
	}

	// Track the active chapter and reading progress once per scroll frame.
	const chapterLinks = [...document.querySelectorAll(".chapter-nav a")];
	const chapters = chapterLinks.map((link) => document.querySelector(link.getAttribute("href")));
	let scrollScheduled = false;
	let activeChapter = -1;

	// Highlight the visible chapter and refresh the reading progress bar.
	function updateChapter() {
		scrollScheduled = false;
		let current = 0;
		chapters.forEach((chapter, index) => {
			if (chapter && chapter.getBoundingClientRect().top <= Math.min(200, window.innerHeight * 0.3)) current = index;
		});
		if (current !== activeChapter) {
			chapterLinks.forEach((link, index) => {
				link.classList.toggle("is-active", index === current);
				if (index === current) link.setAttribute("aria-current", "location");
				else link.removeAttribute("aria-current");
			});
			activeChapter = current;
		}
		const distance = root.scrollHeight - root.clientHeight;
		root.style.setProperty("--page-progress", String(distance > 0 ? Math.min(1, Math.max(0, window.scrollY / distance)) : 1));
	}

	// Coalesce scroll and resize notifications before touching navigation styles.
	function requestChapterUpdate() {
		if (scrollScheduled) return;
		scrollScheduled = true;
		requestAnimationFrame(updateChapter);
	}
	window.addEventListener("scroll", requestChapterUpdate, { passive: true });
	window.addEventListener("resize", requestChapterUpdate, { passive: true });
	updateChapter();
})();
