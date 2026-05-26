# agentR.R - Lightweight HTTP server for remote R session control
# Usage: source("agentR.R"); agentR_serve(9876)
# Stop:  agentR_stop()

# ---------------------------------------------------------------------------
# Console-capture ring buffer
# ---------------------------------------------------------------------------
.agentR_console_log  <- list()
.agentR_console_seq  <- 0L
.agentR_LOG_MAX      <- 500L

.agentR_log <- function(type, content) {
  .agentR_console_seq <<- .agentR_console_seq + 1L
  entry <- list(
    seq       = .agentR_console_seq,
    timestamp = strftime(Sys.time(), "%Y-%m-%dT%H:%M:%OS3"),
    type      = type,
    content   = content
  )
  .agentR_console_log <<- c(.agentR_console_log, list(entry))
  if (length(.agentR_console_log) > .agentR_LOG_MAX) {
    .agentR_console_log <<- tail(.agentR_console_log, .agentR_LOG_MAX)
  }
  invisible(entry$seq)
}

# ---------------------------------------------------------------------------
# Query-string parser  ("?after=5&foo=bar" -> list(after="5", foo="bar"))
# ---------------------------------------------------------------------------
.agentR_parse_qs <- function(query_string) {
  if (is.null(query_string) || query_string == "" || query_string == "?") return(list())
  qs <- sub("^\\?", "", query_string)
  parts <- strsplit(qs, "&", fixed = TRUE)[[1]]
  out <- list()
  for (p in parts) {
    kv <- strsplit(p, "=", fixed = TRUE)[[1]]
    if (length(kv) >= 2) out[[kv[1]]] <- URLdecode(kv[2])
  }
  out
}

# ---------------------------------------------------------------------------
# HTTP response helper
# ---------------------------------------------------------------------------
.agentR_response <- function(status, body,
                             content_type = "application/json") {
  body_raw <- if (is.raw(body)) body
              else charToRaw(jsonlite::toJSON(body, auto_unbox = TRUE, null = "null"))
  list(
    status  = status,
    headers = list(
      "Content-Type"                = content_type,
      "Access-Control-Allow-Origin" = "*"
    ),
    body = body_raw
  )
}

# ---------------------------------------------------------------------------
# Endpoint: GET /status
# ---------------------------------------------------------------------------
.agentR_ep_status <- function(req) {
  .agentR_response(200, list(ok = TRUE, seq = .agentR_console_seq))
}

# ---------------------------------------------------------------------------
# Endpoint: POST /execute
# ---------------------------------------------------------------------------
.agentR_ep_execute <- function(req) {
  # read body
  raw_body <- req$rook.input$read(-1L)
  txt <- if (is.raw(raw_body)) rawToChar(raw_body) else ""
  payload <- tryCatch(jsonlite::fromJSON(txt), error = function(e) NULL)
  if (is.null(payload) || is.null(payload$code)) {
    return(.agentR_response(400, list(error = "Missing 'code' in JSON body")))
  }
  code <- payload$code
  .agentR_log("input", code)

  # capture output
  output <- ""
  error_msg <- NULL
  status_val <- "done"

  sink_active <- sink.number() > 0L
  if (!sink_active) {
    tmp <- tempfile(fileext = ".txt"); file.create(tmp)
    sink(tmp, split = TRUE)
    tryCatch(
      eval(parse(text = code), envir = .GlobalEnv),
      error = function(e) { error_msg <<- conditionMessage(e); status_val <<- "error" }
    )
    sink()
    output <- paste(readLines(tmp, warn = FALSE), collapse = "\n")
    unlink(tmp)
  } else {
    # fallback when user already has a sink active
    res <- tryCatch(
      capture.output(eval(parse(text = code), envir = .GlobalEnv), type = "output"),
      error = function(e) { error_msg <<- conditionMessage(e); status_val <<- "error"; "" }
    )
    output <- paste(res, collapse = "\n")
  }

  .agentR_log("output", output)
  .agentR_response(200, list(
    output = output,
    error  = error_msg,
    status = status_val,
    seq    = .agentR_console_seq
  ))
}

# ---------------------------------------------------------------------------
# Endpoint: GET /console_log?after=N
# ---------------------------------------------------------------------------
.agentR_ep_console_log <- function(req) {
  qs <- .agentR_parse_qs(req$QUERY_STRING)
  after <- if (!is.null(qs$after)) as.integer(qs$after) else 0L
  if (is.na(after)) after <- 0L

  entries <- Filter(function(e) e$seq > after, .agentR_console_log)
  last_seq <- if (length(.agentR_console_log) > 0L)
                .agentR_console_log[[length(.agentR_console_log)]]$seq
              else 0L
  .agentR_response(200, list(entries = entries, last_seq = last_seq))
}

# ---------------------------------------------------------------------------
# Endpoint: GET /readfile?path=...
# ---------------------------------------------------------------------------
.agentR_ep_readfile <- function(req) {
  qs <- .agentR_parse_qs(req$QUERY_STRING)
  if (is.null(qs$path)) return(.agentR_response(400, list(error = "Missing 'path' query param")))
  p <- qs$path
  if (!file.exists(p)) return(.agentR_response(404, list(error = paste("File not found:", p))))
  raw <- tryCatch(readBin(p, "raw", n = file.info(p)$size),
                  error = function(e) NULL)
  if (is.null(raw)) return(.agentR_response(500, list(error = "Failed to read file")))
  .agentR_response(200, raw, content_type = "application/octet-stream")
}

# ---------------------------------------------------------------------------
# Endpoint: DELETE /unlink?path=...
# ---------------------------------------------------------------------------
.agentR_ep_unlink <- function(req) {
  qs <- .agentR_parse_qs(req$QUERY_STRING)
  if (is.null(qs$path)) return(.agentR_response(400, list(error = "Missing 'path' query param")))
  p <- qs$path
  if (!file.exists(p)) return(.agentR_response(404, list(error = paste("File not found:", p))))
  ok <- file.remove(p)
  .agentR_response(200, list(ok = ok))
}

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------
.agentR_call <- function(req) {
  tryCatch({
    method <- req$REQUEST_METHOD
    path   <- req$PATH_INFO

    if (method == "GET"    && path == "/status")       return(.agentR_ep_status(req))
    if (method == "POST"   && path == "/execute")      return(.agentR_ep_execute(req))
    if (method == "GET"    && path == "/console_log")   return(.agentR_ep_console_log(req))
    if (method == "GET"    && path == "/readfile")      return(.agentR_ep_readfile(req))
    if (method == "DELETE" && path == "/unlink")        return(.agentR_ep_unlink(req))

    # CORS preflight
    if (method == "OPTIONS") {
      return(list(
        status = 200,
        headers = list(
          "Access-Control-Allow-Origin"  = "*",
          "Access-Control-Allow-Methods" = "GET,POST,DELETE,OPTIONS",
          "Access-Control-Allow-Headers" = "Content-Type"
        ),
        body = charToRaw("")
      ))
    }

    .agentR_response(404, list(error = paste("Unknown endpoint:", method, path)))
  }, error = function(e) {
    .agentR_response(500, list(error = conditionMessage(e)))
  })
}

# ---------------------------------------------------------------------------
# Background console capture via taskCallback
# ---------------------------------------------------------------------------
.agentR_sink_file    <- NULL
.agentR_sink_pos     <- 0L
.agentR_callback_set <- FALSE

.agentR_background_capture <- function(...) {
  # read any new content from our own sink (if active) and log it
  if (!is.null(.agentR_sink_file) && file.exists(.agentR_sink_file)) {
    lines <- readLines(.agentR_sink_file, warn = FALSE)
    n <- length(lines)
    if (n > .agentR_sink_pos) {
      new_lines <- lines[(.agentR_sink_pos + 1L):n]
      .agentR_sink_pos <<- n
      txt <- paste(new_lines, collapse = "\n")
      if (nzchar(trimws(txt))) .agentR_log("output", txt)
    }
  }
  TRUE  # keep callback active
}

.agentR_start_background_capture <- function() {
  if (.agentR_callback_set) return(invisible(NULL))
  addTaskCallback(.agentR_background_capture, name = "agentR_capture")
  .agentR_callback_set <<- TRUE
  invisible(NULL)
}

.agentR_stop_background_capture <- function() {
  if (.agentR_callback_set) {
    try(removeTaskCallback("agentR_capture"), silent = TRUE)
    .agentR_callback_set <<- FALSE
  }
}

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
agentR_serve <- function(port = 9876L, host = "127.0.0.1") {
  # dependency check
  if (!requireNamespace("httpuv", quietly = TRUE) ||
      !requireNamespace("jsonlite", quietly = TRUE)) {
    stop("agentR requires packages 'httpuv' and 'jsonlite'. Install with:\n",
         "  install.packages(c('httpuv', 'jsonlite'))")
  }

  # reset state
  .agentR_console_log  <<- list()
  .agentR_console_seq  <<- 0L

  server <- httpuv::startServer(host, port, list(call = .agentR_call))
  .agentR_server <<- server

  # start background console capture
  .agentR_start_background_capture()

   message(sprintf("agentR server started on %s:%d", host, port))

  if (interactive()) {
    # Interactive mode (RStudio) — httpuv hooks into R's event loop via the
    # later package. No blocking needed; user can keep typing commands.
    message("Running in interactive mode — console is still available.")
    invisible(server)
  } else {
    # Non-interactive mode (R --slave) — must block manually or R exits.
    message("Running in non-interactive mode — blocking to keep server alive.")
    while (TRUE) {
      httpuv::service()
      Sys.sleep(0.05)
    }
  }
}

agentR_stop <- function() {
  if (exists(".agentR_server", envir = .GlobalEnv)) {
    httpuv::stopServer(.agentR_server)
    .agentR_stop_background_capture()
    message("agentR server stopped")
  } else {
    message("agentR server is not running")
  }
}
