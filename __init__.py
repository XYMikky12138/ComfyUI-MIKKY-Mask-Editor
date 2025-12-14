from .ae_node import MIKKYMaskEditorNode

NODE_CLASS_MAPPINGS = {
    "MIKKYMaskEditorNode": MIKKYMaskEditorNode
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MIKKYMaskEditorNode": "MIKKY Video Mask Editor 🎬"
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]