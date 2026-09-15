@echo off
REM Long runs launched from an interactive/agent shell get killed part-way; the
REM Task Scheduler puts training under the scheduler service instead. Register
REM and start it with:
REM   schtasks /Create /TN BotzinCleanEntity /TR "C:\projetos\botzin\scripts\run-clean-entity-training.cmd" /SC ONCE /ST 00:00 /F
REM   schtasks /Run /TN BotzinCleanEntity
REM
REM --allow-gameplay-frames is required because the dataset is built with
REM --human-annotations: the reviewed frames come from gameplay video, so
REM clean-source isolation is deliberately off. Drop both flags to go back to a
REM purely procedural dataset.
cd /d C:\projetos\botzin

if not exist storage mkdir storage
set LOG=storage\clean-entity-training.log

echo [clean-training] started %DATE% %TIME% > "%LOG%"
.venv\Scripts\python.exe scripts\train-clean-entity-detector.py --device 0 --epochs 100 --batch 8 --workers 2 --allow-gameplay-frames >> "%LOG%" 2>&1
echo [clean-training] exit=%ERRORLEVEL% finished %DATE% %TIME% >> "%LOG%"
