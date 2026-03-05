"""
Shared Folder Service

Provides a shared folder that all Claude CLI sessions can access.
Sessions can read/write files in this shared space to collaborate.
"""

from service.shared_folder.shared_folder_manager import (
    SharedFolderManager,
    get_shared_folder_manager,
)

__all__ = [
    "SharedFolderManager",
    "get_shared_folder_manager",
]
