// Mouse and keyboard input injection on Windows via SendInput.

#include <windows.h>

#include <node_api.h>

#include <cmath>
#include <cstdint>
#include <cstring>
#include <iterator>

namespace {

napi_value MakeBoolean(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

bool GetArguments(napi_env env,
                  napi_callback_info info,
                  size_t expected,
                  napi_value* argv) {
  size_t argc = expected;
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != expected) {
    napi_throw_type_error(env, nullptr, "Wrong number of arguments");
    return false;
  }
  return true;
}

bool GetInteger(napi_env env, napi_value value, int32_t* result) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok ||
      !std::isfinite(number) || number != std::trunc(number) ||
      number < INT32_MIN || number > INT32_MAX) {
    napi_throw_type_error(env, nullptr, "Expected an integer");
    return false;
  }
  *result = static_cast<int32_t>(number);
  return true;
}

bool GetBoolean(napi_env env, napi_value value, bool* result) {
  if (napi_get_value_bool(env, value, result) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a boolean");
    return false;
  }
  return true;
}

bool Send(INPUT* inputs, UINT count) {
  return SendInput(count, inputs, sizeof(INPUT)) == count;
}

napi_value MoveMouse(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  int32_t x;
  int32_t y;
  if (!GetArguments(env, info, 2, argv) || !GetInteger(env, argv[0], &x) ||
      !GetInteger(env, argv[1], &y)) {
    return nullptr;
  }

  const int32_t left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const int32_t top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const int32_t width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  const int32_t height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (x < left || x >= left + width || y < top || y >= top + height) {
    return MakeBoolean(env, false);
  }

  INPUT input = {};
  input.type = INPUT_MOUSE;
  input.mi.dx = MulDiv(x - left, 65535, width - 1);
  input.mi.dy = MulDiv(y - top, 65535, height - 1);
  input.mi.dwFlags =
      MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  if (!Send(&input, 1)) {
    return MakeBoolean(env, false);
  }

  // Windows does not map SendInput's absolute coordinates exactly onto
  // pixels, so the cursor can land a pixel off.  SendInput is still
  // needed for the move to count as user input.
  POINT point;
  if (GetCursorPos(&point) && point.x == x && point.y == y) {
    return MakeBoolean(env, true);
  }
  return MakeBoolean(env, SetCursorPos(x, y) != 0);
}

napi_value SetMouseButton(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  char button[8];
  bool down;
  if (!GetArguments(env, info, 2, argv)) {
    return nullptr;
  }
  if (napi_get_value_string_utf8(env, argv[0], button, sizeof(button),
                                 nullptr) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a string");
    return nullptr;
  }
  if (!GetBoolean(env, argv[1], &down)) {
    return nullptr;
  }

  DWORD flags;
  if (std::strcmp(button, "left") == 0) {
    flags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
  } else if (std::strcmp(button, "right") == 0) {
    flags = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
  } else if (std::strcmp(button, "middle") == 0) {
    flags = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
  } else {
    napi_throw_type_error(env, nullptr, "Unknown mouse button");
    return nullptr;
  }

  INPUT input = {};
  input.type = INPUT_MOUSE;
  input.mi.dwFlags = flags;
  return MakeBoolean(env, Send(&input, 1));
}

napi_value ScrollWheel(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  int32_t delta_x;
  int32_t delta_y;
  if (!GetArguments(env, info, 2, argv) ||
      !GetInteger(env, argv[0], &delta_x) ||
      !GetInteger(env, argv[1], &delta_y)) {
    return nullptr;
  }

  INPUT inputs[2] = {};
  UINT count = 0;
  if (delta_y != 0) {
    inputs[count].type = INPUT_MOUSE;
    inputs[count].mi.mouseData = static_cast<DWORD>(delta_y);
    inputs[count].mi.dwFlags = MOUSEEVENTF_WHEEL;
    count++;
  }
  if (delta_x != 0) {
    inputs[count].type = INPUT_MOUSE;
    inputs[count].mi.mouseData = static_cast<DWORD>(delta_x);
    inputs[count].mi.dwFlags = MOUSEEVENTF_HWHEEL;
    count++;
  }
  return MakeBoolean(env, Send(inputs, count));
}

napi_value SetKey(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  int32_t scan_code;
  bool down;
  if (!GetArguments(env, info, 2, argv) ||
      !GetInteger(env, argv[0], &scan_code) ||
      !GetBoolean(env, argv[1], &down)) {
    return nullptr;
  }

  const bool extended = (scan_code & 0xFF00) == 0xE000;
  if (scan_code <= 0 || scan_code > 0xE0FF || (scan_code > 0xFF && !extended)) {
    napi_throw_range_error(env, nullptr, "Invalid scan code");
    return nullptr;
  }

  INPUT input = {};
  input.type = INPUT_KEYBOARD;
  input.ki.wScan = static_cast<WORD>(scan_code & 0xFF);
  input.ki.dwFlags = KEYEVENTF_SCANCODE;
  if (extended) {
    input.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
  }
  if (!down) {
    input.ki.dwFlags |= KEYEVENTF_KEYUP;
  }
  return MakeBoolean(env, Send(&input, 1));
}

napi_value GetCursorPosition(napi_env env, napi_callback_info info) {
  POINT point;
  if (!GetCursorPos(&point)) {
    napi_throw_error(env, nullptr, "GetCursorPos failed");
    return nullptr;
  }

  napi_value result;
  napi_value x;
  napi_value y;
  napi_create_object(env, &result);
  napi_create_int32(env, point.x, &x);
  napi_create_int32(env, point.y, &y);
  napi_set_named_property(env, result, "x", x);
  napi_set_named_property(env, result, "y", y);
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
      {"moveMouse", nullptr, MoveMouse, nullptr, nullptr, nullptr,
       napi_enumerable, nullptr},
      {"setMouseButton", nullptr, SetMouseButton, nullptr, nullptr, nullptr,
       napi_enumerable, nullptr},
      {"scrollWheel", nullptr, ScrollWheel, nullptr, nullptr, nullptr,
       napi_enumerable, nullptr},
      {"setKey", nullptr, SetKey, nullptr, nullptr, nullptr, napi_enumerable,
       nullptr},
      {"getCursorPosition", nullptr, GetCursorPosition, nullptr, nullptr,
       nullptr, napi_enumerable, nullptr},
  };
  napi_define_properties(env, exports, std::size(properties), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
