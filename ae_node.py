import torch
import numpy as np
from PIL import Image
import base64
from io import BytesIO
import folder_paths
import os
import random
import json
import cv2  # 引入 OpenCV


class MIKKYMaskEditorNode:
    def __init__(self):
        self.output_dir = folder_paths.get_temp_directory()
        self.type = "temp"
        self.prefix_append = "_ae_editor_" + ''.join(random.choice("abcdefghijklmnopqrstubwxyz") for x in range(5))

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "images": ("IMAGE",),
                "mode": (["Original", "BBox", "Square"], {"default": "Original"}),
                "start_frame": ("INT", {"default": 0, "min": 0, "step": 1}),
                "end_frame": ("INT", {"default": 0, "min": 0, "step": 1}),
                # Default 0 to imply full length if not set usually, handled in logic
                "padding": ("INT", {"default": 0, "min": 0, "max": 500}),
                "fill_holes": ("BOOLEAN", {"default": False}),  # 新增：填充孔洞
                "blur_radius": ("INT", {"default": 0, "min": 0, "max": 100}),  # 新增：羽化/模糊
            },
            "optional": {
                "optional_mask": ("MASK",),
            },
            "hidden": {
                "mask_data": ("STRING", {"default": ""}),
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("MASK", "IMAGE")
    RETURN_NAMES = ("mask_batch", "image_batch")  # 改名 image_batch 以体现切片后的图像
    FUNCTION = "process"
    CATEGORY = "MIKKY Editor"
    OUTPUT_NODE = True

    def process(self, images, mode, start_frame, end_frame, padding, fill_holes, blur_radius, mask_data, unique_id,
                optional_mask=None):
        # --- 1. 保存预览图 (用于前端显示，保存所有帧以便用户选择) ---
        ui_images = []
        ui_masks = []

        # 这里的保存逻辑保持不变，确保前端能看到完整序列进行绘制
        for i, tensor in enumerate(images):
            img_np = (tensor.numpy() * 255).astype(np.uint8)
            img_pil = Image.fromarray(img_np)
            filename = f"{self.prefix_append}_{i:05}.webp"
            img_pil.save(os.path.join(self.output_dir, filename), quality=80)
            ui_images.append({"filename": filename, "type": self.type, "subfolder": ""})

        if optional_mask is not None:
            for i, m_tensor in enumerate(optional_mask):
                if i >= len(images): break
                m_np = (m_tensor.numpy() * 255).astype(np.uint8)
                m_pil = Image.fromarray(m_np, mode='L')
                filename = f"{self.prefix_append}_mask_{i:05}.webp"
                m_pil.save(os.path.join(self.output_dir, filename), quality=80)
                ui_masks.append({"filename": filename, "type": self.type, "subfolder": ""})

        # --- 2. 解析多帧遮罩数据 ---
        drawn_masks_dict = {}
        if mask_data:
            try:
                if mask_data.startswith("{"):
                    drawn_masks_dict = json.loads(mask_data)
                elif mask_data.startswith("data:image"):
                    drawn_masks_dict = {"0": mask_data}
            except Exception as e:
                print(f"[AE Editor] Error parsing mask data: {e}")

        def decode_mask(b64_str, w, h):
            try:
                header, encoded = b64_str.split(",", 1)
                data = base64.b64decode(encoded)
                img = Image.open(BytesIO(data))
                if img.mode == 'RGBA':
                    _, _, _, alpha = img.split()
                    return alpha.resize((w, h))
                else:
                    return img.convert('L').resize((w, h))
            except:
                return Image.new('L', (w, h), 0)

        batch_size, height, width, _ = images.shape

        # --- 3. 计算切片范围 ---
        # 如果 end_frame 为 0 或 -1 或大于总帧数，则取到最后
        actual_end = batch_size if (end_frame <= 0 or end_frame > batch_size) else end_frame
        actual_start = max(0, min(start_frame, actual_end))

        # 确保范围有效
        if actual_start >= actual_end:
            actual_start = 0
            actual_end = batch_size

        # 切片图像 (Output Image Batch)
        # 这实现了“选择出指定范围的帧图像”
        sliced_images = images[actual_start:actual_end]
        sliced_batch_size = sliced_images.shape[0]

        # 初始化输出 Mask Tensor (大小与切片后的图像一致)
        final_mask_batch = torch.zeros((sliced_batch_size, height, width), dtype=torch.float32)

        # --- 4. 逐帧处理 (仅处理切片范围内的帧) ---
        for i in range(sliced_batch_size):
            # 计算原始 Batch 中的绝对索引，用于查找 mask_data 和 optional_mask
            original_idx = actual_start + i

            # A. 组合基础遮罩(Optional) 和 手绘遮罩(Drawn)
            if optional_mask is not None:
                # 循环使用 optional_mask 防止索引越界
                mask_idx = original_idx if original_idx < len(optional_mask) else original_idx % len(optional_mask)
                base_tensor = optional_mask[mask_idx]
            else:
                base_tensor = torch.zeros((height, width), dtype=torch.float32)

            str_idx = str(original_idx)
            if str_idx in drawn_masks_dict:
                pil_mask = decode_mask(drawn_masks_dict[str_idx], width, height)
                drawn_tensor = torch.from_numpy(np.array(pil_mask).astype(np.float32) / 255.0)
            else:
                drawn_tensor = torch.zeros((height, width), dtype=torch.float32)

            combined_tensor = torch.max(base_tensor, drawn_tensor)

            # 转换为 Numpy uint8 进行 OpenCV 处理
            mask_np = (combined_tensor.numpy() * 255).astype(np.uint8)

            # --- 新功能: Fill Holes (填充孔洞) ---
            if fill_holes and np.max(mask_np) > 0:
                # 查找外部轮廓
                contours, _ = cv2.findContours(mask_np, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                # 填充所有外部轮廓的内部
                cv2.drawContours(mask_np, contours, -1, 255, -1)

            # --- 模式处理: BBox / Square ---
            if mode != "Original" and np.max(mask_np) > 0:
                contours, _ = cv2.findContours(mask_np, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                box_canvas = np.zeros_like(mask_np)

                if contours:
                    for cnt in contours:
                        x, y, w, h = cv2.boundingRect(cnt)
                        x1, y1, x2, y2 = x, y, x + w, y + h

                        # 应用 Padding
                        x1 = max(0, x1 - padding)
                        y1 = max(0, y1 - padding)
                        x2 = min(width, x2 + padding)
                        y2 = min(height, y2 + padding)

                        if mode == "Square":
                            w_box = x2 - x1
                            h_box = y2 - y1
                            size = max(w_box, h_box)
                            center_x = (x1 + x2) // 2
                            center_y = (y1 + y2) // 2

                            half = size // 2
                            x1_sq = center_x - half
                            y1_sq = center_y - half
                            x2_sq = x1_sq + size
                            y2_sq = y1_sq + size

                            x1 = max(0, x1_sq)
                            y1 = max(0, y1_sq)
                            x2 = min(width, x2_sq)
                            y2 = min(height, y2_sq)

                        cv2.rectangle(box_canvas, (int(x1), int(y1)), (int(x2), int(y2)), 255, -1)

                mask_np = box_canvas  # 更新 mask_np 为 bbox 结果

            # --- 新功能: Blur (模糊/羽化) ---
            if blur_radius > 0:
                # 核大小必须是奇数
                k_size = blur_radius * 2 + 1
                mask_np = cv2.GaussianBlur(mask_np, (k_size, k_size), 0)

            # 转回 Tensor
            final_mask_batch[i] = torch.from_numpy(mask_np.astype(np.float32) / 255.0)

        # 这里不需要扩展通道，ComfyUI 的 MASK 类型通常是 (N, H, W)
        # 如果需要预览图像，我们通常不作为主要输出，但为了兼容旧代码的 RETURN_TYPES...
        # 这里返回的是 切片后的图像 batch
        return {
            "ui": {"ae_images": ui_images, "ae_masks": ui_masks},
            "result": (final_mask_batch, sliced_images)
        }