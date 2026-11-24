package main

// DSH 任务代理：以 headless 模式调用 dsh CLI 执行复杂任务（后台运行，内存任务表）

import (
	"encoding/json"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

type dshJob struct {
	ID             string
	Prompt         string
	Status         string // running | done | exit_N | failed
	Output         string
	StartedAt      string
	EndedAt        any // null 或 ISO 字符串
	ExitCode       int
	projectChanged bool
	pid            int
}

var (
	dshMu   sync.Mutex
	dshJobs = map[string]*dshJob{}
	dshSeq  int
)

func projectJSON() string {
	data, ok := dbGetProject()
	if !ok {
		return "null"
	}
	b, _ := json.Marshal(data)
	return string(b)
}

func startDshJob(prompt string) *dshJob {
	dshMu.Lock()
	defer dshMu.Unlock()
	dshSeq++
	id := "job_" + strconv.FormatInt(time.Now().UnixMilli(), 36) + "_" + strconv.Itoa(dshSeq)
	job := &dshJob{ID: id, Prompt: prompt, Status: "running", StartedAt: isoNow()}
	dshJobs[id] = job
	before := projectJSON()

	cmd := exec.Command("dsh", "--profile", "headless", "--permission-mode", "danger-full-access", "-")
	cmd.Dir = appRoot
	cmd.Env = append(os.Environ(), "DSH_NON_INTERACTIVE=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		job.Status = "failed"
		job.Output += "\n[启动失败] " + err.Error() + "（请确认 dsh 已安装并在 PATH 中）"
		job.EndedAt = isoNow()
		return job
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		job.Status = "failed"
		job.Output += "\n[启动失败] " + err.Error() + "（请确认 dsh 已安装并在 PATH 中）"
		job.EndedAt = isoNow()
		return job
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		job.Status = "failed"
		job.Output += "\n[启动失败] " + err.Error() + "（请确认 dsh 已安装并在 PATH 中）"
		job.EndedAt = isoNow()
		return job
	}
	if err := cmd.Start(); err != nil {
		job.Status = "failed"
		job.Output += "\n[启动失败] " + err.Error() + "（请确认 dsh 已安装并在 PATH 中）"
		job.EndedAt = isoNow()
		return job
	}
	job.pid = cmd.Process.Pid

	stdin.Write([]byte(prompt))
	stdin.Close()

	go func() {
		buf := make([]byte, 65536)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				dshMu.Lock()
				job.Output += string(buf[:n])
				dshMu.Unlock()
			}
			if err != nil {
				break
			}
		}
	}()
	go func() {
		buf := make([]byte, 65536)
		for {
			n, err := stderr.Read(buf)
			if n > 0 {
				dshMu.Lock()
				job.Output += string(buf[:n])
				dshMu.Unlock()
			}
			if err != nil {
				break
			}
		}
	}()
	go func() {
		err := cmd.Wait()
		dshMu.Lock()
		defer dshMu.Unlock()
		code := 0
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			} else {
				code = -1
			}
		}
		job.ExitCode = code
		if code == 0 {
			job.Status = "done"
		} else {
			job.Status = "exit_" + strconv.Itoa(code)
		}
		job.EndedAt = isoNow()
		job.projectChanged = projectJSON() != before
	}()
	return job
}

func getDshJob(id string) *dshJob {
	dshMu.Lock()
	defer dshMu.Unlock()
	return dshJobs[id]
}
