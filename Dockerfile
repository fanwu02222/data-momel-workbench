# ---- 构建阶段 ----
FROM golang:1.23-alpine AS build
WORKDIR /src
ENV GOPROXY=https://goproxy.cn,direct
COPY go.mod go.sum ./
RUN go mod download
COPY main.go store.go excel.go dsh.go ./
COPY index.html css js ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /dw-workbench-go .

# ---- 运行阶段 ----
FROM alpine:3.20
WORKDIR /app
COPY --from=build /dw-workbench-go ./dw-workbench-go
# 数据目录独立于应用目录，便于持久化挂载
ENV PORT=8130 \
    HOST=0.0.0.0 \
    DW_DATA_DIR=/data
VOLUME /data
EXPOSE 8130
CMD ["./dw-workbench-go"]
