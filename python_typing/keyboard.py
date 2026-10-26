"""Keyboard backends with a hard safety boundary around PyAutoGUI."""

from __future__ import annotations

from typing import Protocol

from .models import KeyAction


class KeyboardBackend(Protocol):
    def write_char(self, char: str) -> None: ...

    def press(self, key: str) -> None: ...


class RecordingKeyboard:
    """Records operations for dry-run output and never touches the keyboard."""

    def __init__(self) -> None:
        self.actions: list[KeyAction] = []

    def write_char(self, char: str) -> None:
        self.actions.append(KeyAction("write", char))

    def press(self, key: str) -> None:
        self.actions.append(KeyAction("press", key))


class PyAutoGUIKeyboard:
    """Real keyboard backend, imported only for explicit execute mode."""

    def __init__(self) -> None:
        import pyautogui

        self._pyautogui = pyautogui
        # Moving the mouse to the upper-left corner aborts PyAutoGUI actions.
        self._pyautogui.FAILSAFE = True

    def write_char(self, char: str) -> None:
        self._pyautogui.write(char)

    def press(self, key: str) -> None:
        self._pyautogui.press(key)
