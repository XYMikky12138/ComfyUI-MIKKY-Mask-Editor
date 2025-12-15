import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "AE.MaskEditor",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "MIKKYMaskEditorNode") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                this.ae_widget = new AEMaskEditorWidget(this);
                this.setSize([500, 600]); 
                return r;
            };

            const onResize = nodeType.prototype.onResize;
            nodeType.prototype.onResize = function (size) {
                if (onResize) onResize.apply(this, arguments);
                if (this.ae_widget) {
                    this.ae_widget.resize(size[0], size[1]);
                }
            };

            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function(message) {
                const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
                if (message && message.ae_images) {
                    this.ae_widget.updateData(message.ae_images, message.ae_masks || []);
                }
                return r;
            };
        }
    }
});

class AEMaskEditorWidget {
    constructor(node) {
        this.node = node;
        this.images = []; 
        this.inputMasks = [];
        this.currentFrame = 0;
        this.brushSize = 25;
        this.maskStorage = {}; 

        // 状态追踪
        this.isDrawing = false;
        this.lastPos = { x: 0, y: 0 };
        this.currentCompositeOperation = "source-over"; 
        this.currentStrokeStyle = "#ff0000";
        this.statusTimer = null; 

        // 光标相关状态
        this.cursorTimer = null; 
        this.isCursorVisible = false;

        this.element = this.createDOM();
        this.widget = node.addDOMWidget("ae_editor_ui", "Editor", this.element, {
            serialize: false,
            hideOnZoom: false
        });
        
        this.maskDataWidget = this.node.widgets.find(w => w.name === "mask_data");
        if (!this.maskDataWidget) {
            this.maskDataWidget = { name: "mask_data", value: "" };
            this.node.widgets.push(this.maskDataWidget);
        }
    }

    createDOM() {
        const container = document.createElement("div");
        container.style.cssText = `
            display: flex; flex-direction: column; background: #1a1a1a; border-radius: 8px;
            border: 2px solid #333; overflow: hidden; font-family: sans-serif;
            width: 100%; height: 100%; box-sizing: border-box; outline: none; transition: border-color 0.2s;
        `;
        container.tabIndex = 0;

        container.onfocus = () => { container.style.borderColor = "#2196F3"; };
        container.onblur = () => { container.style.borderColor = "#333"; };

        // Viewport
        this.viewport = document.createElement("div");
        this.viewport.style.cssText = "position: relative; width: 100%; background: #000; display: flex; justify-content: center; align-items: center; overflow: hidden; flex-grow: 1;";
        
        // Stack Container
        this.stackContainer = document.createElement("div");
        this.stackContainer.style.cssText = "position: relative; width: 0; height: 0; box-shadow: 0 0 10px rgba(0,0,0,0.5);";

        this.imgEl = new Image();
        this.imgEl.style.cssText = "display: block; width: 100%; height: 100%; pointer-events: none; user-select: none;";
        
        this.canvasInputMask = document.createElement("canvas");
        this.canvasInputMask.style.cssText = "position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; opacity: 0.6; mix-blend-mode: screen;";

        this.canvasDraw = document.createElement("canvas");
        this.canvasDraw.style.cssText = "position: absolute; top: 0; left: 0; width: 100%; height: 100%; cursor: crosshair; opacity: 0.7;";
        
        // --- 光标 ---
        this.brushCursor = document.createElement("div");
        this.brushCursor.style.cssText = `
            position: absolute; 
            pointer-events: none; 
            border: 1px solid rgba(255, 255, 255, 0.9); 
            box-shadow: 0 0 2px rgba(0, 0, 0, 0.8);
            border-radius: 50%; 
            transform: translate(-50%, -50%);
            display: none; 
            z-index: 100;
        `;

        this.stackContainer.appendChild(this.imgEl);
        this.stackContainer.appendChild(this.canvasInputMask);
        this.stackContainer.appendChild(this.canvasDraw);
        this.stackContainer.appendChild(this.brushCursor); 
        this.viewport.appendChild(this.stackContainer);
        container.appendChild(this.viewport);

        // Controls
        this.controlsWrapper = document.createElement("div");
        this.controlsWrapper.style.cssText = "padding: 10px; background: #222; border-top: 1px solid #333; color: #ccc; flex-shrink: 0;";

        // Slider
        const row1 = document.createElement("div");
        row1.style.cssText = "display: flex; align-items: center; gap: 8px; margin-bottom: 10px;";
        
        this.slider = document.createElement("input");
        this.slider.type = "range";
        this.slider.min = 0; this.slider.max = 0; this.slider.value = 0;
        this.slider.style.cssText = "flex-grow: 1; height: 6px; accent-color: #e57373; cursor: pointer;";
        this.slider.disabled = true;

        this.frameInfo = document.createElement("span");
        this.frameInfo.innerText = "Empty";
        this.frameInfo.style.cssText = "font-size: 11px; font-variant-numeric: tabular-nums; width: 60px; text-align: right;";

        row1.appendChild(this.slider);
        row1.appendChild(this.frameInfo);
        this.controlsWrapper.appendChild(row1);

        // Buttons
        const row2 = document.createElement("div");
        row2.style.cssText = "display: flex; gap: 8px; align-items: center; flex-wrap: wrap;";
        
        this.btnClearFrame = document.createElement("button");
        this.btnClearFrame.innerText = "🗑 Current";
        this.btnClearFrame.style.cssText = "background: #333; color: #fff; border: 1px solid #444; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;";

        this.btnClearAll = document.createElement("button");
        this.btnClearAll.innerText = "🗑 All Frames";
        this.btnClearAll.style.cssText = "background: #522; color: #fff; border: 1px solid #633; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;";

        const legend = document.createElement("span");
        legend.innerText = "L: Draw | R: Erase";
        legend.style.cssText = "font-size: 10px; color: #666; margin-left: auto;";

        row2.appendChild(this.btnClearFrame);
        row2.appendChild(this.btnClearAll);
        row2.appendChild(legend);
        this.controlsWrapper.appendChild(row2);

        // Status
        this.statusDiv = document.createElement("div");
        this.statusDiv.style.cssText = "font-size: 10px; color: #e57373; margin-top: 5px; height: 16px; line-height: 16px; text-align: center; font-weight: bold; overflow: hidden;";
        this.statusDiv.innerText = "● Mask Edited on this frame";
        this.statusDiv.style.visibility = "hidden";
        this.controlsWrapper.appendChild(this.statusDiv);

        container.appendChild(this.controlsWrapper);

        this.ctxDraw = this.canvasDraw.getContext("2d");
        this.ctxInput = this.canvasInputMask.getContext("2d");

        this.bindEvents(container);
        
        setTimeout(() => this.resize(this.node.size[0], this.node.size[1]), 100);

        return container;
    }

    resize(nodeWidth, nodeHeight) {
        requestAnimationFrame(() => {
            this.fitCanvas();
        });
    }

    // 修复后的坐标获取方法：保证获取到的是 Canvas 内部的 CSS 坐标
    // 之前使用 getBoundingClientRect 会受到 ComfyUI 整体缩放的影响
    getCanvasPos(e) {
        // e.offsetX / e.offsetY 是相对于事件目标（Canvas）的坐标
        // 这直接对应了 Canvas 上的 CSS 像素位置，忽略了屏幕缩放
        // 只有当 e.target 确实是 canvasDraw 时才准确（由于光标是 pointer-events: none，所以总是准确的）
        
        // 我们还需要将 CSS 像素坐标转换为 Canvas 内部的原始分辨率坐标
        // CSS Width (Layout) -> Natural Width (Resolution)
        
        const cssWidth = parseFloat(this.stackContainer.style.width) || this.stackContainer.clientWidth;
        const naturalWidth = this.canvasDraw.width;
        
        if (!cssWidth || !naturalWidth) return { x: 0, y: 0 };

        const scaleX = naturalWidth / cssWidth;
        const scaleY = this.canvasDraw.height / (parseFloat(this.stackContainer.style.height) || this.stackContainer.clientHeight);

        return { 
            x: e.offsetX * scaleX, 
            y: e.offsetY * scaleY 
        };
    }

    // 修复后的光标视觉更新逻辑
    updateCursorVisual(e) {
        const naturalWidth = this.canvasDraw.width;
        // 获取容器在布局中的逻辑宽度（不受屏幕缩放影响）
        const cssWidth = parseFloat(this.stackContainer.style.width);
        
        if (!naturalWidth || !cssWidth) return;

        // 计算比例：1个 Canvas原始像素 等于 多少 CSS逻辑像素
        const ratio = cssWidth / naturalWidth;
        
        // 1. 设置大小
        // brushSize 是原始像素大小，乘以 ratio 得到 CSS 像素大小
        const cursorSize = this.brushSize * ratio;
        this.brushCursor.style.width = `${cursorSize}px`;
        this.brushCursor.style.height = `${cursorSize}px`;
        
        // 2. 设置位置
        // 直接使用 offsetX/Y，这是相对于父容器的 CSS 坐标，非常准确
        this.brushCursor.style.left = `${e.offsetX}px`;
        this.brushCursor.style.top = `${e.offsetY}px`;
        
        this.brushCursor.style.display = "block";
    }

    bindEvents(container) {
        this.resizeObserver = new ResizeObserver(() => {
            this.fitCanvas();
        });
        this.resizeObserver.observe(this.viewport);

        // --- 鼠标滚轮调整画笔大小 ---
        this.canvasDraw.addEventListener("wheel", (e) => {
            e.preventDefault(); 
            e.stopPropagation();

            const step = 2;
            if (e.deltaY < 0) {
                this.brushSize = Math.min(this.brushSize + step, 300);
            } else {
                this.brushSize = Math.max(this.brushSize - step, 1);
            }

            // 1. 更新底部文字
            this.statusDiv.innerText = `Brush Size: ${this.brushSize}px`;
            this.statusDiv.style.visibility = "visible";
            if (this.statusTimer) clearTimeout(this.statusTimer);
            this.statusTimer = setTimeout(() => {
                this.updateStatus();
            }, 1000);

            // 2. 更新光标
            this.isCursorVisible = true;
            this.updateCursorVisual(e);

            // 3. 延迟隐藏
            if (this.cursorTimer) clearTimeout(this.cursorTimer);
            this.cursorTimer = setTimeout(() => {
                this.brushCursor.style.display = "none";
                this.isCursorVisible = false;
            }, 800);

        }, { passive: false });

        // --- 鼠标移动 ---
        this.canvasDraw.addEventListener("mousemove", (e) => {
            // 注意：这里我们单独计算 lastPos 用于绘图，逻辑与之前保持一致
            // 但为了代码整洁，getCanvasPos 现在也被重构为更健壮的版本
            this.lastPos = this.getCanvasPos(e);

            if (this.isCursorVisible) {
                this.updateCursorVisual(e);
            }

            if (this.isDrawing) {
                this.ctxDraw.lineTo(this.lastPos.x, this.lastPos.y);
                this.ctxDraw.stroke();
            }
        });

        this.canvasDraw.addEventListener("mouseleave", () => {
            if (this.isDrawing) {
                const endDrawEvent = new Event('mouseup');
                this.canvasDraw.dispatchEvent(endDrawEvent);
            }
            this.brushCursor.style.display = "none";
            this.isCursorVisible = false;
        });

        // --- 键盘事件 ---
        container.addEventListener("keydown", (e) => {
            if (!this.images || this.images.length === 0) return;

            let delta = 0;
            if (e.key === "a" || e.key === "A" || e.key === "ArrowLeft") {
                delta = -1;
            } 
            else if (e.key === "d" || e.key === "D" || e.key === "ArrowRight") {
                delta = 1;
            }

            if (delta !== 0) {
                e.preventDefault(); 
                e.stopPropagation();

                const maxFrame = this.images.length - 1;
                const newFrame = Math.max(0, Math.min(maxFrame, this.currentFrame + delta));
                
                if (newFrame !== this.currentFrame) {
                    if (this.isDrawing) {
                        this.maskStorage[this.currentFrame] = this.canvasDraw.toDataURL("image/png");
                        this.saveAllMasks();
                    }

                    this.currentFrame = newFrame;
                    this.slider.value = this.currentFrame;
                    
                    this.showFrame(this.currentFrame);
                }
            }
        });

        this.slider.addEventListener("mousedown", (e) => { e.stopPropagation(); container.focus(); });
        this.slider.oninput = (e) => {
            const newFrame = parseInt(e.target.value);
            if (newFrame !== this.currentFrame) {
                this.currentFrame = newFrame;
                this.showFrame(this.currentFrame);
            }
        };

        this.btnClearFrame.onclick = () => {
            this.ctxDraw.clearRect(0, 0, this.canvasDraw.width, this.canvasDraw.height);
            delete this.maskStorage[this.currentFrame];
            this.saveAllMasks();
            this.updateStatus();
            container.focus();
        };

        this.btnClearAll.onclick = () => {
            if(confirm("Clear masks for ALL frames?")) {
                this.ctxDraw.clearRect(0, 0, this.canvasDraw.width, this.canvasDraw.height);
                this.maskStorage = {};
                this.saveAllMasks();
                this.updateStatus();
            }
            container.focus();
        };

        this.canvasDraw.addEventListener("contextmenu", (e) => { 
            e.preventDefault(); 
            e.stopPropagation(); 
            return false; 
        });

        // --- 鼠标点击 ---
        this.canvasDraw.addEventListener("mousedown", (e) => {
            e.stopPropagation(); 
            e.preventDefault();
            container.focus();
            
            this.brushCursor.style.display = "none";
            this.isCursorVisible = false;

            if (!this.images.length) return;
            
            this.isDrawing = true;
            this.ctxDraw.beginPath();
            this.ctxDraw.lineCap = "round";
            this.ctxDraw.lineJoin = "round";
            
            // 计算绘图时的线宽 (Scale Logic)
            const cssWidth = parseFloat(this.stackContainer.style.width);
            const naturalWidth = this.canvasDraw.width;
            const scale = naturalWidth / cssWidth; // 这里的 scale 是把 CSS 像素转回 原始像素
            
            this.ctxDraw.lineWidth = this.brushSize; // 直接使用 brushSize，因为 Canvas 上下文是基于原始分辨率的
            // 注意：之前的代码这里可能有误解，ctxDraw.lineWidth 应该直接等于 brushSize (如果是基于原始分辨率绘图)
            // 除非我们想让 brushSize 代表屏幕像素大小。
            // 通常逻辑是：BrushSize = 50 意味着在图片上画 50px 的宽的线。
            // 所以这里直接 this.ctxDraw.lineWidth = this.brushSize 是最正确的物理定义。
            
            // *修正*: 之前的代码使用了 rect计算，这里直接赋值即可，因为我们现在有了更准确的坐标转换
            this.ctxDraw.lineWidth = this.brushSize;

            if (e.button === 0) {
                this.currentCompositeOperation = "source-over";
                this.currentStrokeStyle = "#ff0000";
            } else if (e.button === 2) {
                this.currentCompositeOperation = "destination-out";
                this.currentStrokeStyle = "rgba(0,0,0,1)";
            }

            this.ctxDraw.globalCompositeOperation = this.currentCompositeOperation;
            this.ctxDraw.strokeStyle = this.currentStrokeStyle;

            const pos = this.getCanvasPos(e);
            this.lastPos = pos;
            this.ctxDraw.moveTo(pos.x, pos.y);
            this.ctxDraw.lineTo(pos.x, pos.y);
            this.ctxDraw.stroke();
        });

        const endDraw = () => {
            if (this.isDrawing) {
                this.isDrawing = false;
                this.ctxDraw.closePath();
                this.ctxDraw.globalCompositeOperation = "source-over";
                this.maskStorage[this.currentFrame] = this.canvasDraw.toDataURL("image/png");
                this.saveAllMasks();
                this.updateStatus();
                container.focus();
            }
        };

        this.canvasDraw.addEventListener("mouseup", endDraw);
    }

    saveAllMasks() {
        if (this.maskDataWidget) {
            this.maskDataWidget.value = JSON.stringify(this.maskStorage);
        }
    }

    updateData(images, masks) {
        this.images = images || [];
        this.inputMasks = masks || [];
        
        if (!this.maskDataWidget.value) {
            this.maskStorage = {};
        } else {
            try {
                if (this.maskDataWidget.value.startsWith("{")) {
                    this.maskStorage = JSON.parse(this.maskDataWidget.value);
                }
            } catch(e) {}
        }

        if (this.images.length > 0) {
            this.slider.disabled = false;
            this.slider.max = this.images.length - 1;
            if (this.currentFrame >= this.images.length) this.currentFrame = 0;
            this.slider.value = this.currentFrame;
            this.showFrame(this.currentFrame);
        } else {
            this.frameInfo.innerText = "Empty";
        }
    }

    showFrame(index) {
        if (!this.images[index]) return;
        
        this.frameInfo.innerText = `${index + 1} / ${this.images.length}`;
        this.updateStatus();

        const imgInfo = this.images[index];
        const params = new URLSearchParams(imgInfo);
        params.append("format", "webp");
        this.imgEl.src = api.apiURL(`/view?${params.toString()}`);

        this.imgEl.onload = () => {
            this.fitCanvas();
            this.loadInputMask(index);
            
            this.ctxDraw.clearRect(0, 0, this.canvasDraw.width, this.canvasDraw.height);

            const resumeStroke = () => {
                if (this.isDrawing) {
                    this.ctxDraw.globalCompositeOperation = this.currentCompositeOperation;
                    this.ctxDraw.strokeStyle = this.currentStrokeStyle;
                    this.ctxDraw.lineCap = "round";
                    this.ctxDraw.lineJoin = "round";

                    this.ctxDraw.lineWidth = this.brushSize;

                    this.ctxDraw.beginPath();
                    this.ctxDraw.moveTo(this.lastPos.x, this.lastPos.y);
                    this.ctxDraw.lineTo(this.lastPos.x, this.lastPos.y); 
                    this.ctxDraw.stroke();
                }
            };

            if (this.maskStorage[index]) {
                const storedMask = new Image();
                storedMask.onload = () => {
                    this.ctxDraw.globalCompositeOperation = "source-over";
                    this.ctxDraw.drawImage(storedMask, 0, 0);
                    resumeStroke();
                };
                storedMask.src = this.maskStorage[index];
            } else {
                resumeStroke();
            }
        };
    }

    fitCanvas() {
        if (!this.imgEl.naturalWidth) return;

        const vw = this.viewport.clientWidth;
        const vh = this.viewport.clientHeight;
        
        if (vw === 0 || vh === 0) return;

        const nw = this.imgEl.naturalWidth;
        const nh = this.imgEl.naturalHeight;

        const imgRatio = nw / nh;
        const viewportRatio = vw / vh;

        let finalW, finalH;

        if (imgRatio > viewportRatio) {
            finalW = vw;
            finalH = vw / imgRatio;
        } else {
            finalW = vh * imgRatio;
            finalH = vh;
        }

        this.stackContainer.style.width = `${finalW}px`;
        this.stackContainer.style.height = `${finalH}px`;

        if (this.canvasDraw.width !== nw || this.canvasDraw.height !== nh) {
            this.canvasDraw.width = nw;
            this.canvasDraw.height = nh;
            this.canvasInputMask.width = nw;
            this.canvasInputMask.height = nh;
        }
    }

    loadInputMask(index) {
        this.ctxInput.clearRect(0, 0, this.canvasInputMask.width, this.canvasInputMask.height);
        if (this.inputMasks.length > 0) {
            const maskIdx = Math.min(index, this.inputMasks.length - 1);
            const maskInfo = this.inputMasks[maskIdx];
            const mParams = new URLSearchParams(maskInfo);
            mParams.append("format", "webp");
            const maskImg = new Image();
            maskImg.src = api.apiURL(`/view?${mParams.toString()}`);
            maskImg.onload = () => {
                this.ctxInput.globalAlpha = 1.0;
                this.ctxInput.drawImage(maskImg, 0, 0, this.canvasInputMask.width, this.canvasInputMask.height);
            };
        }
    }

    updateStatus() {
        this.statusDiv.innerText = "● Mask Edited on this frame";
        if (this.maskStorage[this.currentFrame]) {
            this.statusDiv.style.visibility = "visible";
        } else {
            this.statusDiv.style.visibility = "hidden";
        }
    }
}
