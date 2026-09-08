pipeline {
    agent any

    environment {
        APP_NAME = 'transfer-bot'
        APP_IMAGE = 'transfer-bot:v1.0'
        DOCKER_NETWORK = 'red-gane-int'
    }

    stages {
        stage('Copy .env files') {
            steps {
                withCredentials([file(credentialsId: 'ENV_TRANSFER_BOT', variable: 'ENV_TRANSFER_BOT_FILE')]) {
                    sh 'rm -f .env && cp "$ENV_TRANSFER_BOT_FILE" .env'
                }
            }
        }

        stage('Docker Compose Down') {
            steps {
                sh 'docker compose down --remove-orphans || true'
            }
        }

        stage('Delete Old Image') {
            steps {
                sh "docker rmi ${APP_IMAGE} || true"
            }
        }

        stage('Docker Compose Up') {
            steps {
                sh 'docker compose up -d --build'
            }
        }

        stage('Verify') {
            steps {
                sh 'sleep 10 && docker compose exec -T app node -e "fetch(\"http://127.0.0.1:3000/api/health\").then(response => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"'
            }
        }
    }

    post {
        failure {
            sh 'docker compose logs --tail=50 || true'
        }
    }
}
