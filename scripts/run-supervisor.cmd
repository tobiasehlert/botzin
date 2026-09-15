@echo off
REM Host-side supervisor for the agent and the annotation UI. The panel runs in a
REM container and can only record a desired state; this is what actually spawns.
REM
REM Keep it running under the Task Scheduler so it survives closing the shell:
REM   schtasks /Create /TN BotzinSupervisor /TR "C:\projetos\botzin\scripts\run-supervisor.cmd" /SC ONSTART /RL HIGHEST /F
REM   schtasks /Run /TN BotzinSupervisor
cd /d C:\projetos\botzin

if not exist storage mkdir storage
set LOG=storage\supervisor.log

echo [supervisor] started %DATE% %TIME% > "%LOG%"
npm.cmd run supervisor >> "%LOG%" 2>&1
echo [supervisor] exit=%ERRORLEVEL% finished %DATE% %TIME% >> "%LOG%"
