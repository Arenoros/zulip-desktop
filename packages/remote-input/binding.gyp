{
  "targets": [
    {
      "target_name": "remote_input",
      "sources": ["remote_input.cc"],
      "defines": ["NAPI_VERSION=8", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
      "libraries": ["user32.lib"]
    }
  ]
}
