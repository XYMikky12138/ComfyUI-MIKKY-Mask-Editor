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

        // 焦点反馈
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
        this.canvasDraw.style.cssText = "position: absolute; top: 0; left: 0; width: 100%; height: 100%; cursor: crosshair;";
        
        this.stackContainer.appendChild(this.imgEl);
        this.stackContainer.appendChild(this.canvasInputMask);
        this.stackContainer.appendChild(this.canvasDraw);
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
        // 修改点：固定高度和行高，防止任何布局抖动
        this.statusDiv = document.createElement("div");
        this.statusDiv.style.cssText = "font-size: 10px; color: #e57373; margin-top: 5px; height: 16px; line-height: 16px; text-align: center; font-weight: bold; overflow: hidden;";
        this.statusDiv.innerText = "● Mask Edited on this frame";
        this.statusDiv.style.visibility = "hidden"; // 初始隐藏，占据空间
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

    bindEvents(container) {
        this.resizeObserver = new ResizeObserver(() => {
            this.fitCanvas();
        });
        this.resizeObserver.observe(this.viewport);

        // 键盘事件
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

        let isDrawing = false;
        
        const getPos = (e) => {
            const rect = this.canvasDraw.getBoundingClientRect();
            const scaleX = this.canvasDraw.width / rect.width;
            const scaleY = this.canvasDraw.height / rect.height;
            return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
        };

        this.canvasDraw.addEventListener("mousedown", (e) => {
            e.stopPropagation(); 
            e.preventDefault();
            container.focus(); // 聚焦

            if (!this.images.length) return;
            isDrawing = true;
            this.ctxDraw.beginPath();
            this.ctxDraw.lineCap = "round";
            this.ctxDraw.lineJoin = "round";
            
            const rect = this.canvasDraw.getBoundingClientRect();
            const scale = this.canvasDraw.width / rect.width;
            this.ctxDraw.lineWidth = this.brushSize * scale; 

            if (e.button === 0) {
                this.ctxDraw.globalCompositeOperation = "source-over";
                this.ctxDraw.strokeStyle = "#ff0000";
            } else if (e.button === 2) {
                this.ctxDraw.globalCompositeOperation = "destination-out";
                this.ctxDraw.strokeStyle = "rgba(0,0,0,1)";
            }

            const pos = getPos(e);
            this.ctxDraw.moveTo(pos.x, pos.y);
        });

        this.canvasDraw.addEventListener("mousemove", (e) => {
            if (!isDrawing) return;
            const pos = getPos(e);
            this.ctxDraw.lineTo(pos.x, pos.y);
            this.ctxDraw.stroke();
        });

        const endDraw = () => {
            if (isDrawing) {
                isDrawing = false;
                this.ctxDraw.closePath();
                this.ctxDraw.globalCompositeOperation = "source-over";
                this.maskStorage[this.currentFrame] = this.canvasDraw.toDataURL("image/png");
                this.saveAllMasks();
                this.updateStatus();
                container.focus(); // 保持焦点
            }
        };

        this.canvasDraw.addEventListener("mouseup", endDraw);
        this.canvasDraw.addEventListener("mouseleave", endDraw);
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
            if (this.maskStorage[index]) {
                const storedMask = new Image();
                storedMask.onload = () => {
                    this.ctxDraw.drawImage(storedMask, 0, 0);
                };
                storedMask.src = this.maskStorage[index];
            }
        };
    }

    fitCanvas() {
        if (!this.imgEl.naturalWidth) return;

        const viewportRect = this.viewport.getBoundingClientRect();
        const vw = viewportRect.width;
        const vh = viewportRect.height;
        
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
        // 核心修复：始终保留文字，通过 visibility 切换显示
        // 这样可以确保占用的空间高度绝对不变，防止画面缩放抖动
        this.statusDiv.innerText = "● Mask Edited on this frame";
        if (this.maskStorage[this.currentFrame]) {
            this.statusDiv.style.visibility = "visible";
        } else {
            this.statusDiv.style.visibility = "hidden";
        }
    }
}